import { asc, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  GetBookmarksResponse,
  GetChecksumResponse,
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
import { listTrash, restoreSubtree } from '../sync/restore.js';
import { collectStats } from '../sync/stats.js';
import { buildTree } from '../sync/tree.js';
import { validateOpsBody } from '../sync/validate.js';

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;

export interface SyncRoutesOptions {
  db: Db;
  syncToken: string;
  retentionDays: number;
}

/** All sync routes; registered under the /api prefix, bearer-authenticated. */
export function syncRoutes(
  app: FastifyInstance,
  { db, syncToken, retentionDays }: SyncRoutesOptions,
): void {
  app.addHook('onRequest', bearerAuth(syncToken));

  app.post('/ops', (request, reply): PostOpsResponse | undefined => {
    const validated = validateOpsBody(request.body);
    if ('error' in validated) {
      void reply.code(400).send({ error: validated.error });
      return;
    }
    return applyOps(db, validated.ops);
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
    return { restored: outcome.restored, serverVersion: currentServerVersion(db) };
  });

  app.get('/stats', (): GetStatsResponse => {
    return collectStats(db, retentionDays, currentServerVersion(db));
  });
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}
