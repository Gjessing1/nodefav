import type { ServerResponse } from 'node:http';
import { asc, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  DeviceInfo,
  GetBookmarksResponse,
  GetChecksumResponse,
  GetDevicesResponse,
  GetMetaResponse,
  GetOpsResponse,
  GetStatsResponse,
  GetTrashResponse,
  PostOpsResponse,
  PostRestoreResponse,
  RemoteOp,
  SyncOp,
} from '@nodefav/shared';
import { bearerAuth } from '../auth/bearer.js';
import type { Db } from '../database/db.js';
import { operations } from '../database/schema.js';
import { applyOps, currentServerVersion } from '../sync/applyOps.js';
import { computeChecksum } from '../sync/checksum.js';
import type { VersionBus } from '../sync/events.js';
import { listDevices, upsertDevice, validateDeviceReport } from '../sync/devices.js';
import { listMeta } from '../jobs/enrichment.js';
import { listTrash, restoreSubtree } from '../sync/restore.js';
import { collectStats } from '../sync/stats.js';
import { buildTree } from '../sync/tree.js';
import { validateOpsBody } from '../sync/validate.js';

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;
const EVENTS_HEARTBEAT_MS = 25_000;

export interface SyncRoutesOptions {
  db: Db;
  syncToken: string;
  retentionDays: number;
  bus: VersionBus;
}

/** All sync routes; registered under the /api prefix, bearer-authenticated. */
export function syncRoutes(
  app: FastifyInstance,
  { db, syncToken, retentionDays, bus }: SyncRoutesOptions,
): void {
  app.addHook('onRequest', bearerAuth(syncToken));

  app.post('/ops', (request, reply): PostOpsResponse | undefined => {
    const validated = validateOpsBody(request.body);
    if ('error' in validated) {
      void reply.code(400).send({ error: validated.error });
      return;
    }
    const response = applyOps(db, validated.ops);
    if (response.results.some((result) => result.status === 'applied')) {
      bus.publish(response.serverVersion);
    }
    return response;
  });

  app.get('/ops', (request, reply): GetOpsResponse | undefined => {
    const query = request.query as { since?: string; limit?: string };
    const since = parseNonNegativeInt(query.since, 0);
    const limit = parseNonNegativeInt(query.limit, DEFAULT_PULL_LIMIT);
    if (since === undefined || limit === undefined || limit === 0) {
      void reply.code(400).send({ error: 'since and limit must be non-negative integers' });
      return;
    }

    const rows = db
      .select({ seq: operations.seq, payload: operations.payload })
      .from(operations)
      .where(gt(operations.seq, since))
      .orderBy(asc(operations.seq))
      .limit(Math.min(limit, MAX_PULL_LIMIT))
      .all();
    const ops = rows.map((row): RemoteOp => {
      const payload = JSON.parse(row.payload) as SyncOp & { uuid: string };
      return { ...payload, seq: row.seq };
    });
    return { ops, serverVersion: currentServerVersion(db) };
  });

  app.get('/bookmarks', (): GetBookmarksResponse => {
    return { roots: buildTree(db), serverVersion: currentServerVersion(db) };
  });

  app.get('/checksum', (): GetChecksumResponse => {
    return computeChecksum(db, currentServerVersion(db));
  });

  app.get('/trash', (): GetTrashResponse => {
    return { items: listTrash(db), serverVersion: currentServerVersion(db) };
  });

  app.post('/restore', (request, reply): PostRestoreResponse | undefined => {
    const { uuid } = (request.body ?? {}) as { uuid?: unknown };
    if (typeof uuid !== 'string' || uuid.length === 0) {
      void reply.code(400).send({ error: 'uuid must be a non-empty string' });
      return;
    }
    const outcome = restoreSubtree(db, uuid, Date.now());
    if ('error' in outcome) {
      const status = outcome.error === 'not-found' ? 404 : 400;
      void reply
        .code(status)
        .send({ error: `${outcome.error === 'not-found' ? 'unknown' : 'not deleted'}: ${uuid}` });
      return;
    }
    const serverVersion = currentServerVersion(db);
    if (outcome.restored > 0) bus.publish(serverVersion);
    return { restored: outcome.restored, serverVersion };
  });

  app.get('/stats', (): GetStatsResponse => {
    return collectStats(db, retentionDays, currentServerVersion(db), bus.size());
  });

  // Device registry: each browser reports its name + extension version, so the
  // admin page can tell browsers apart and flag outdated installs.
  app.put('/devices/:deviceId', (request, reply): DeviceInfo | undefined => {
    const { deviceId } = request.params as { deviceId: string };
    const report = validateDeviceReport(request.body);
    if ('error' in report) {
      void reply.code(400).send({ error: report.error });
      return;
    }
    return upsertDevice(db, deviceId, report, Date.now());
  });

  app.get('/devices', (): GetDevicesResponse => {
    return { devices: listDevices(db) };
  });

  app.get('/meta', (): GetMetaResponse => {
    return { items: listMeta(db), serverVersion: currentServerVersion(db) };
  });

  // Realtime change feed (SSE, Phase 6). Emits `version` events carrying the
  // server version: one on connect (so a client that missed anything catches up
  // immediately) and one whenever an op is appended. Comment-line heartbeats
  // keep proxies and the extension's service worker from idling the stream out.
  const streams = new Set<ServerResponse>();
  app.get('/events', (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (serverVersion: number): void => {
      raw.write(`event: version\ndata: ${JSON.stringify({ serverVersion })}\n\n`);
    };
    send(currentServerVersion(db));
    streams.add(raw);
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), EVENTS_HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(raw);
    });
  });
  // Hijacked responses are invisible to Fastify — end them ourselves on close
  // so tests and graceful shutdowns don't hang on open streams.
  app.addHook('onClose', () => {
    for (const raw of streams) raw.end();
  });
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}
