import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type {
  BookmarkNode,
  GetBookmarksResponse,
  GetChecksumResponse,
  GetOpsResponse,
  GetStatsResponse,
  GetTrashResponse,
  PostOpsResponse,
  PostRestoreResponse,
  SyncOp,
} from '@nodefav/shared';
import { buildApp } from '../app.js';
import { createDb } from '../database/db.js';
import { purgeExpired } from '../jobs/retention.js';
import type { Db } from '../database/db.js';

const TOKEN = 'test-token';

function makeApp(): { app: FastifyInstance; db: Db } {
  const db = createDb(':memory:');
  return { app: buildApp({ db, syncToken: TOKEN, retentionDays: 30, logger: false }), db };
}

let opCounter = 0;
function op<T extends Partial<SyncOp> & { type: SyncOp['type'] }>(fields: T) {
  opCounter += 1;
  return {
    opId: `p5-op-${opCounter}`,
    deviceId: 'device-test',
    timestamp: 1_000 + opCounter,
    ...fields,
  };
}

async function request<T>(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  expected = 200,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload,
  });
  assert.equal(res.statusCode, expected, `${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

/** folder A [ b1, folder B [ b2 ] ] — returns the four uuids. */
async function seedTree(app: FastifyInstance) {
  const created = await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [
      op({ type: 'create', nodeType: 'folder', parentUuid: null, title: 'A', sortOrder: 'a0' }),
    ],
  });
  const a = created.results[0]?.uuid as string;
  const children = await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [
      op({
        type: 'create',
        nodeType: 'bookmark',
        parentUuid: a,
        title: 'b1',
        url: 'https://example.com/b1',
        sortOrder: 'a0',
      }),
      op({ type: 'create', nodeType: 'folder', parentUuid: a, title: 'B', sortOrder: 'a1' }),
    ],
  });
  const b1 = children.results[0]?.uuid as string;
  const b = children.results[1]?.uuid as string;
  const leaf = await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [
      op({
        type: 'create',
        nodeType: 'bookmark',
        parentUuid: b,
        title: 'b2',
        url: 'https://example.com/b2',
        sortOrder: 'a0',
      }),
    ],
  });
  const b2 = leaf.results[0]?.uuid as string;
  return { a, b1, b, b2 };
}

function flatten(roots: BookmarkNode[]): Map<string, BookmarkNode> {
  const map = new Map<string, BookmarkNode>();
  const walk = (node: BookmarkNode): void => {
    map.set(node.uuid, node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return map;
}

test('trash lists soft-deleted nodes; restore brings back the cascade subtree', async () => {
  const { app } = makeApp();
  const { a, b2 } = await seedTree(app);

  await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [op({ type: 'delete', uuid: a })],
  });

  const trash = await request<GetTrashResponse>(app, 'GET', '/api/trash');
  assert.equal(trash.items.length, 4);
  assert.ok(trash.items.every((item) => item.deletedAt > 0));

  const before = await request<GetBookmarksResponse>(app, 'GET', '/api/bookmarks');
  assert.equal(before.roots.length, 0);

  const restored = await request<PostRestoreResponse>(app, 'POST', '/api/restore', { uuid: a });
  assert.equal(restored.restored, 4);

  const after = await request<GetBookmarksResponse>(app, 'GET', '/api/bookmarks');
  const nodes = flatten(after.roots);
  assert.equal(nodes.size, 4);
  assert.equal(nodes.get(b2)?.title, 'b2');
  assert.equal((await request<GetTrashResponse>(app, 'GET', '/api/trash')).items.length, 0);

  // Restore propagates through the op log as synthetic creates with preset uuids.
  const ops = await request<GetOpsResponse>(app, 'GET', '/api/ops?since=0&limit=100');
  const restores = ops.ops.filter((o) => o.deviceId === 'server:restore');
  assert.equal(restores.length, 4);
  assert.ok(restores.every((o) => o.type === 'create' && typeof o.uuid === 'string'));
});

test('restoring a child of a deleted folder reparents to the nearest live ancestor', async () => {
  const { app } = makeApp();
  const { a, b, b2 } = await seedTree(app);

  // Delete b2 alone, then folder B: two independent trash entries.
  await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [op({ type: 'delete', uuid: b2 }), op({ type: 'delete', uuid: b })],
  });

  const restored = await request<PostRestoreResponse>(app, 'POST', '/api/restore', { uuid: b2 });
  assert.equal(restored.restored, 1); // B was deleted separately — stays in trash

  const tree = await request<GetBookmarksResponse>(app, 'GET', '/api/bookmarks');
  const nodes = flatten(tree.roots);
  assert.equal(nodes.get(b2)?.parentUuid, a);
  assert.equal(nodes.has(b), false);
});

test('restore rejects unknown, purged and live nodes', async () => {
  const { app, db } = makeApp();
  const { a, b1 } = await seedTree(app);

  await request(app, 'POST', '/api/restore', { uuid: 'missing' }, 404);
  await request(app, 'POST', '/api/restore', { uuid: a }, 400); // not deleted
  await request(app, 'POST', '/api/restore', {}, 400);

  await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [op({ type: 'delete', uuid: b1 })],
  });
  purgeExpired(db, Date.now() + 1);
  await request(app, 'POST', '/api/restore', { uuid: b1 }, 404); // purged
});

test('checksum ignores op order and root rows, reflects live content', async () => {
  const first = makeApp();
  const second = makeApp();

  await seedTree(first.app);
  await seedTree(second.app);

  const c1 = await request<GetChecksumResponse>(first.app, 'GET', '/api/checksum');
  const c2 = await request<GetChecksumResponse>(second.app, 'GET', '/api/checksum');
  assert.notEqual(c1.checksum, c2.checksum); // uuids differ between servers

  assert.equal(c1.count, 3); // root folder A excluded
  assert.equal(c1.rootUuids.length, 1);

  const before = c1.checksum;
  const roots = await request<GetBookmarksResponse>(first.app, 'GET', '/api/bookmarks');
  const a = roots.roots[0]?.uuid as string;
  await request<PostOpsResponse>(first.app, 'POST', '/api/ops', {
    ops: [op({ type: 'update', uuid: a, title: 'A renamed' })],
  });
  const afterRootRename = await request<GetChecksumResponse>(first.app, 'GET', '/api/checksum');
  assert.equal(afterRootRename.checksum, before); // root title excluded

  const b1 = roots.roots[0]?.children?.[0]?.uuid as string;
  await request<PostOpsResponse>(first.app, 'POST', '/api/ops', {
    ops: [op({ type: 'update', uuid: b1, title: 'renamed' })],
  });
  const afterChildRename = await request<GetChecksumResponse>(first.app, 'GET', '/api/checksum');
  assert.notEqual(afterChildRename.checksum, before);
});

test('stats reports counts, retention and database size', async () => {
  const { app } = makeApp();
  const { b1 } = await seedTree(app);
  await request<PostOpsResponse>(app, 'POST', '/api/ops', {
    ops: [op({ type: 'delete', uuid: b1 })],
  });

  const stats = await request<GetStatsResponse>(app, 'GET', '/api/stats');
  assert.equal(stats.bookmarks.live, 3);
  assert.equal(stats.bookmarks.deleted, 1);
  assert.equal(stats.operations.total, 5);
  assert.ok((stats.operations.lastAppliedAt ?? 0) > 0);
  assert.ok(stats.database.sizeBytes > 0);
  assert.equal(stats.retention.days, 30);
  assert.equal(stats.serverVersion, 5);
});

test('new endpoints require the bearer token', async () => {
  const { app } = makeApp();
  for (const [method, url] of [
    ['GET', '/api/trash'],
    ['GET', '/api/checksum'],
    ['GET', '/api/stats'],
    ['POST', '/api/restore'],
  ] as const) {
    const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});
