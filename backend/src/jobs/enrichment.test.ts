import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CreateOp, DeleteOp } from '@nodefav/shared';
import { createDb } from '../database/db.js';
import { applyOps } from '../sync/applyOps.js';
import { collectStats } from '../sync/stats.js';
import {
  DEAD_LINK_THRESHOLD,
  RECHECK_INTERVAL_MS,
  extractPageMeta,
  listMeta,
  runEnrichment,
} from './enrichment.js';

let opCounter = 0;
function createBookmark(title: string, url: string): CreateOp {
  return {
    opId: `op-${++opCounter}`,
    deviceId: 'device-test',
    timestamp: 1_000,
    type: 'create',
    parentUuid: null,
    nodeType: 'bookmark',
    title,
    url,
    sortOrder: 'a0',
  };
}

function createFolder(title: string): CreateOp {
  return {
    opId: `op-${++opCounter}`,
    deviceId: 'device-test',
    timestamp: 1_000,
    type: 'create',
    parentUuid: null,
    nodeType: 'folder',
    title,
    sortOrder: 'a0',
  };
}

function deleteOp(uuid: string): DeleteOp {
  return {
    opId: `op-${++opCounter}`,
    deviceId: 'device-test',
    timestamp: 2_000,
    type: 'delete',
    uuid,
  };
}

/** A fetch stub keyed by URL; unrouted URLs fail like a network error. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return Promise.reject(new Error(`connection refused: ${url}`));
    return Promise.resolve(route());
  };
  return Object.assign(fetchFn as typeof fetch, { calls });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// --- extractPageMeta ------------------------------------------------------

test('extractPageMeta pulls the title and resolves the icon href', () => {
  const html = `<html><head>
    <title> My &amp; Site —\n  Docs </title>
    <link rel="stylesheet" href="/app.css">
    <link rel="shortcut icon" href='/img/fav.png'>
  </head><body><title>not this one</title></body>`;
  assert.deepEqual(extractPageMeta(html, 'https://site.test/deep/page'), {
    pageTitle: 'My & Site — Docs',
    faviconUrl: 'https://site.test/img/fav.png',
  });
});

test('extractPageMeta handles missing pieces and unquoted attributes', () => {
  assert.deepEqual(extractPageMeta('<p>no head</p>', 'https://site.test/'), {});
  assert.deepEqual(extractPageMeta('<title></title>', 'https://site.test/'), {});
  assert.deepEqual(extractPageMeta('<link rel=icon href=favicon.svg>', 'https://site.test/a/'), {
    faviconUrl: 'https://site.test/a/favicon.svg',
  });
});

// --- runEnrichment --------------------------------------------------------

test('enrichment checks live bookmarks only and records title, favicon, health', async () => {
  const db = createDb(':memory:');
  const { results } = applyOps(db, [
    createBookmark('with-icon', 'https://a.test/'),
    createBookmark('plain', 'https://b.test/'),
    createBookmark('deleted', 'https://gone.test/'),
    createFolder('folder'),
  ]);
  applyOps(db, [deleteOp(results[2]?.uuid as string)]);

  const fetchFn = fakeFetch({
    'https://a.test/': () => htmlResponse('<title>Site A</title><link rel="icon" href="/fav.ico">'),
    'https://b.test/': () =>
      new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
  });
  const result = await runEnrichment(db, { fetchFn, now: 10_000 });

  assert.deepEqual(result, { checked: 2, ok: 2, failing: 0, dead: 0, skipped: 0 });
  assert.ok(!fetchFn.calls.includes('https://gone.test/'));

  const meta = listMeta(db);
  assert.equal(meta.length, 2);
  const withIcon = meta.find((m) => m.title === 'with-icon');
  assert.equal(withIcon?.health, 'ok');
  assert.equal(withIcon?.httpStatus, 200);
  assert.equal(withIcon?.pageTitle, 'Site A');
  assert.equal(withIcon?.faviconUrl, 'https://a.test/fav.ico');
  assert.equal(withIcon?.okAt, 10_000);
  const plain = meta.find((m) => m.title === 'plain');
  assert.equal(plain?.health, 'ok');
  assert.equal(plain?.pageTitle, null); // non-HTML body is not parsed
  assert.equal(plain?.faviconUrl, 'https://b.test/favicon.ico'); // default fallback

  const stats = collectStats(db, 30, 0, 0);
  assert.deepEqual(stats.enrichment, { checked: 2, dead: 0, pending: 0 });
});

test('non-http schemes are skipped once and never rechecked', async () => {
  const db = createDb(':memory:');
  applyOps(db, [createBookmark('js', 'javascript:void(0)')]);
  const fetchFn = fakeFetch({});

  const first = await runEnrichment(db, { fetchFn, now: 10_000 });
  assert.deepEqual(first, { checked: 1, ok: 0, failing: 0, dead: 0, skipped: 1 });
  assert.equal(fetchFn.calls.length, 0);

  const later = await runEnrichment(db, { fetchFn, now: 10_000 + 2 * RECHECK_INTERVAL_MS });
  assert.equal(later.checked, 0);
});

test('consecutive failures escalate to dead, and a recovery resets them', async () => {
  const db = createDb(':memory:');
  applyOps(db, [createBookmark('flaky', 'https://down.test/')]);

  const failing = fakeFetch({}); // unrouted → network error
  let now = 10_000;
  for (let attempt = 1; attempt <= DEAD_LINK_THRESHOLD; attempt++) {
    const result = await runEnrichment(db, { fetchFn: failing, now });
    assert.equal(result.checked, 1);
    const [meta] = listMeta(db);
    assert.equal(meta?.consecutiveFailures, attempt);
    assert.equal(meta?.health, attempt < DEAD_LINK_THRESHOLD ? 'failing' : 'dead');
    now += RECHECK_INTERVAL_MS;
  }
  assert.equal(collectStats(db, 30, 0, 0).enrichment.dead, 1);

  // Dead links stay on the recheck schedule and may recover.
  const recovered = fakeFetch({ 'https://down.test/': () => htmlResponse('<title>Back</title>') });
  const result = await runEnrichment(db, { fetchFn: recovered, now });
  assert.deepEqual(result, { checked: 1, ok: 1, failing: 0, dead: 0, skipped: 0 });
  const [meta] = listMeta(db);
  assert.equal(meta?.health, 'ok');
  assert.equal(meta?.consecutiveFailures, 0);
  assert.equal(meta?.pageTitle, 'Back');
  assert.equal(meta?.okAt, now);
});

test('failures keep the last known title and favicon', async () => {
  const db = createDb(':memory:');
  applyOps(db, [createBookmark('was-ok', 'https://site.test/')]);

  const ok = fakeFetch({ 'https://site.test/': () => htmlResponse('<title>Known</title>') });
  await runEnrichment(db, { fetchFn: ok, now: 10_000 });

  const failing = fakeFetch({ 'https://site.test/': () => htmlResponse('gone', 500) });
  await runEnrichment(db, { fetchFn: failing, now: 10_000 + RECHECK_INTERVAL_MS });

  const [meta] = listMeta(db);
  assert.equal(meta?.health, 'failing');
  assert.equal(meta?.httpStatus, 500);
  assert.equal(meta?.pageTitle, 'Known');
  assert.equal(meta?.okAt, 10_000);
});

test('bookmarks are rechecked only after the recheck interval', async () => {
  const db = createDb(':memory:');
  applyOps(db, [createBookmark('fresh', 'https://site.test/')]);
  const fetchFn = fakeFetch({ 'https://site.test/': () => htmlResponse('<title>T</title>') });

  await runEnrichment(db, { fetchFn, now: 10_000 });
  const tooSoon = await runEnrichment(db, { fetchFn, now: 10_000 + RECHECK_INTERVAL_MS - 1 });
  assert.equal(tooSoon.checked, 0);
  const due = await runEnrichment(db, { fetchFn, now: 10_000 + RECHECK_INTERVAL_MS });
  assert.equal(due.checked, 1);
});

test('batches respect the size limit and pick never-checked bookmarks first', async () => {
  const db = createDb(':memory:');
  applyOps(db, [
    createBookmark('a', 'https://a.test/'),
    createBookmark('b', 'https://b.test/'),
    createBookmark('c', 'https://c.test/'),
  ]);
  const fetchFn = fakeFetch({
    'https://a.test/': () => htmlResponse(''),
    'https://b.test/': () => htmlResponse(''),
    'https://c.test/': () => htmlResponse(''),
  });

  const first = await runEnrichment(db, { fetchFn, now: 10_000, batchSize: 2 });
  assert.equal(first.checked, 2);
  assert.equal(collectStats(db, 30, 0, 0).enrichment.pending, 1);

  const second = await runEnrichment(db, { fetchFn, now: 10_000, batchSize: 2 });
  assert.equal(second.checked, 1); // only the leftover — fresh rows are not due
  assert.equal(new Set(fetchFn.calls).size, 3); // each URL fetched exactly once
  assert.equal(collectStats(db, 30, 0, 0).enrichment.pending, 0);
});
