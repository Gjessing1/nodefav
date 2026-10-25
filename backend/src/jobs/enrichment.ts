import { and, asc, eq, isNull, lte, ne, or } from 'drizzle-orm';
import type { LinkHealth, MetaItem } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarkMeta, bookmarks } from '../database/schema.js';

/**
 * Background enrichment (Phase 6): visits live bookmark URLs and records
 * cloud-side metadata — page title, favicon URL and link health. Runs in small
 * hourly batches so a large tree enriches over a day or two without hammering
 * anyone. Metadata never flows back into native bookmark fields.
 *
 * Thumbnails are deliberately out of scope: they need a headless browser,
 * which doesn't fit the slim runtime image (recorded in ROADMAP.md).
 */

/** Consecutive failed checks before a link counts as dead. */
export const DEAD_LINK_THRESHOLD = 3;
export const DEFAULT_ENRICH_BATCH = 20;
/** Every bookmark is rechecked at this cadence (dead ones may recover). */
export const RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60_000;

const FETCH_TIMEOUT_MS = 15_000;
/** Titles/favicons live in <head>; this is plenty and bounds memory. */
const MAX_HTML_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 300;
const USER_AGENT = 'nodefav-enrichment/1.0 (+https://git.gjessing.io/gjessing1/nodefav)';

export interface EnrichmentOptions {
  fetchFn?: typeof fetch;
  now?: number;
  batchSize?: number;
}

export interface EnrichmentResult {
  checked: number;
  ok: number;
  failing: number;
  dead: number;
  unverified: number;
  skipped: number;
}

/** One batch: pick the stalest due bookmarks, fetch each, upsert its meta row. */
export async function runEnrichment(
  db: Db,
  options: EnrichmentOptions = {},
): Promise<EnrichmentResult> {
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? fetch;
  const batchSize = options.batchSize ?? DEFAULT_ENRICH_BATCH;

  // Due: live bookmarks never checked, or checked longer than the recheck
  // interval ago. `skipped` rows are permanent (a scheme never becomes http).
  const candidates = db
    .select({
      uuid: bookmarks.uuid,
      url: bookmarks.url,
      failures: bookmarkMeta.consecutiveFailures,
    })
    .from(bookmarks)
    .leftJoin(bookmarkMeta, eq(bookmarkMeta.uuid, bookmarks.uuid))
    .where(
      and(
        isNull(bookmarks.deletedAt),
        eq(bookmarks.type, 'bookmark'),
        or(
          isNull(bookmarkMeta.uuid),
          and(
            ne(bookmarkMeta.health, 'skipped'),
            lte(bookmarkMeta.checkedAt, now - RECHECK_INTERVAL_MS),
          ),
        ),
      ),
    )
    .orderBy(asc(bookmarkMeta.checkedAt)) // nulls first: never-checked before recheck
    .limit(batchSize)
    .all();

  const result: EnrichmentResult = {
    checked: 0,
    ok: 0,
    failing: 0,
    dead: 0,
    unverified: 0,
    skipped: 0,
  };
  for (const candidate of candidates) {
    const outcome = await checkOne(fetchFn, candidate.url);
    const health: LinkHealth =
      outcome.kind === 'skipped'
        ? 'skipped'
        : outcome.kind === 'ok'
          ? 'ok'
          : outcome.kind === 'unverified'
            ? 'unverified'
            : (candidate.failures ?? 0) + 1 >= DEAD_LINK_THRESHOLD
              ? 'dead'
              : 'failing';
    const failures = outcome.kind === 'failed' ? (candidate.failures ?? 0) + 1 : 0;
    const row = {
      health,
      httpStatus: outcome.kind === 'skipped' ? null : (outcome.httpStatus ?? null),
      consecutiveFailures: failures,
      checkedAt: now,
      ...(outcome.kind === 'ok'
        ? {
            pageTitle: outcome.pageTitle ?? null,
            faviconUrl: outcome.faviconUrl ?? null,
            okAt: now,
          }
        : {}), // failures keep the last known title/favicon
    };
    db.insert(bookmarkMeta)
      .values({ uuid: candidate.uuid, pageTitle: null, faviconUrl: null, okAt: null, ...row })
      .onConflictDoUpdate({ target: bookmarkMeta.uuid, set: row })
      .run();
    result.checked++;
    result[health]++;
  }
  return result;
}

type CheckOutcome =
  | { kind: 'ok'; httpStatus: number; pageTitle?: string; faviconUrl?: string }
  | { kind: 'failed'; httpStatus?: number }
  | { kind: 'unverified'; httpStatus?: number }
  | { kind: 'skipped' };

async function checkOne(fetchFn: typeof fetch, url: string | null): Promise<CheckOutcome> {
  if (url === null) return { kind: 'skipped' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'skipped' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'skipped' };

  try {
    const response = await fetchFn(parsed.href, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: response.status === 404 || response.status === 410 ? 'failed' : 'unverified',
        httpStatus: response.status,
      };
    }
    const contentType = response.headers.get('content-type') ?? '';
    let pageTitle: string | undefined;
    let faviconUrl: string | undefined;
    if (contentType.includes('text/html') && response.body) {
      const html = await readHead(response.body);
      const extracted = extractPageMeta(html, response.url || parsed.href);
      pageTitle = extracted.pageTitle;
      faviconUrl = extracted.faviconUrl;
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    faviconUrl ??= new URL('/favicon.ico', response.url || parsed.href).href;
    return { kind: 'ok', httpStatus: response.status, pageTitle, faviconUrl };
  } catch {
    // DNS, VPN, auth and bot protection can differ between the server and browser.
    return { kind: 'unverified' };
  }
}

/** Reads at most MAX_HTML_BYTES of the body, then cancels the rest. */
async function readHead(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder(); // UTF-8 with replacement — fine for <head> scanning
  let html = '';
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) return html;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return html;
  } finally {
    reader.releaseLock();
  }
}

/** Pulls <title> and the icon <link> out of an HTML fragment. Exported for tests. */
export function extractPageMeta(
  html: string,
  baseUrl: string,
): { pageTitle?: string; faviconUrl?: string } {
  const result: { pageTitle?: string; faviconUrl?: string } = {};

  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    const title = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    if (title.length > 0) result.pageTitle = title.slice(0, MAX_TITLE_LENGTH);
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel');
    if (rel === undefined || !/(^|\s)(shortcut\s+)?icon(\s|$)/i.test(rel)) continue;
    const href = attr(tag, 'href');
    if (href === undefined) continue;
    try {
      result.faviconUrl = new URL(decodeEntities(href), baseUrl).href;
      break;
    } catch {
      /* unresolvable href — keep looking */
    }
  }
  return result;
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Everything enriched so far, joined with the bookmark it describes. */
export function listMeta(db: Db): MetaItem[] {
  return db
    .select({
      uuid: bookmarkMeta.uuid,
      title: bookmarks.title,
      url: bookmarks.url,
      health: bookmarkMeta.health,
      httpStatus: bookmarkMeta.httpStatus,
      pageTitle: bookmarkMeta.pageTitle,
      faviconUrl: bookmarkMeta.faviconUrl,
      consecutiveFailures: bookmarkMeta.consecutiveFailures,
      checkedAt: bookmarkMeta.checkedAt,
      okAt: bookmarkMeta.okAt,
    })
    .from(bookmarkMeta)
    .innerJoin(bookmarks, eq(bookmarks.uuid, bookmarkMeta.uuid))
    .orderBy(asc(bookmarks.title))
    .all();
}
