import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type {
  BookmarkNode,
  CreateOp,
  GetBookmarksResponse,
  GetOpsResponse,
  PostOpsResponse,
  SyncOp,
} from '@nodefav/shared';
import { buildApp } from '../app.js';
import { createDb } from '../database/db.js';
import { bookmarks } from '../database/schema.js';
import { applyOps } from '../sync/applyOps.js';
import { buildTree } from '../sync/tree.js';

const TOKEN = 'test-token';

function makeApp() {
  const db = createDb(':memory:');
  return { app: buildApp({ db, syncToken: TOKEN, logger: false }), db };
}

let opCounter = 0;
function op<T extends Partial<SyncOp> & { type: SyncOp['type'] }>(
  fields: T,
): T & {
  opId: string;
  deviceId: string;
  timestamp: number;
} {
  opCounter += 1;
  return {
    opId: `op-${opCounter}`,
    deviceId: 'device-test',
    timestamp: 1_000 + opCounter,
    ...fields,
  };
}

function createFolder(title: string, extra: Partial<CreateOp> = {}) {
  return op({
    type: 'create',
    nodeType: 'folder',
    parentUuid: null,
    title,
    sortOrder: 'a0',
    ...extra,
  });
}

function createBookmark(title: string, extra: Partial<CreateOp> = {}) {
  return op({
    type: 'create',
    nodeType: 'bookmark',
    parentUuid: null,
    title,
    url: `https://example.com/${title}`,
    sortOrder: 'a0',
    ...extra,
  });
}

async function postOps(app: FastifyInstance, ops: unknown[]): Promise<PostOpsResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ops',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { ops },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as PostOpsResponse;
}

async function getTree(app: FastifyInstance): Promise<GetBookmarksResponse> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/bookmarks',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as GetBookmarksResponse;
}

async function getOps(app: FastifyInstance, since = 0): Promise<GetOpsResponse> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/ops?since=${since}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as GetOpsResponse;
}

test('sync routes require a valid bearer token', async () => {
  const { app } = makeApp();
  for (const headers of [
    {},
    { authorization: 'Bearer wrong-token' },
    { authorization: 'Basic x' },
  ]) {
    for (const [method, url] of [
      ['POST', '/api/ops'],
      ['GET', '/api/ops'],
      ['GET', '/api/bookmarks'],
    ] as const) {
      const res = await app.inject({ method, url, headers, payload: { ops: [] } });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  }
  await app.close();
});

test('create/update/move/delete lifecycle builds the expected tree', async () => {
  const { app } = makeApp();

  const first = await postOps(app, [createFolder('Work'), createBookmark('docs')]);
  assert.deepEqual(
    first.results.map((r) => r.status),
    ['applied', 'applied'],
  );
  const folderUuid = first.results[0]!.uuid!;
  const bookmarkUuid = first.results[1]!.uuid!;

  await postOps(app, [
    op({ type: 'update', uuid: bookmarkUuid, title: 'Docs (renamed)' }),
    op({ type: 'move', uuid: bookmarkUuid, parentUuid: folderUuid, sortOrder: 'b0' }),
  ]);

  const { roots } = await getTree(app);
  assert.equal(roots.length, 1);
  const folder = roots[0]!;
  assert.equal(folder.uuid, folderUuid);
  assert.equal(folder.type, 'folder');
  assert.equal(folder.children!.length, 1);
  assert.equal(folder.children![0]!.title, 'Docs (renamed)');
  assert.equal(folder.children![0]!.parentUuid, folderUuid);

  await app.close();
});

test('re-uploading a batch is idempotent', async () => {
  const { app } = makeApp();
  const batch = [createFolder('A'), createBookmark('b')];

  const first = await postOps(app, batch);
  const second = await postOps(app, batch);

  assert.deepEqual(
    second.results.map((r) => r.status),
    ['duplicate', 'duplicate'],
  );
  // Duplicates return the original uuid and seq, and nothing new is logged.
  assert.deepEqual(
    second.results.map((r) => [r.uuid, r.seq]),
    first.results.map((r) => [r.uuid, r.seq]),
  );
  assert.equal(second.serverVersion, first.serverVersion);
  assert.equal((await getOps(app)).ops.length, 2);

  await app.close();
});

test('server version increases monotonically with applied ops', async () => {
  const { app } = makeApp();

  const r1 = await postOps(app, [createFolder('A')]);
  const r2 = await postOps(app, [createBookmark('b'), createBookmark('c')]);
  const r3 = await postOps(app, [op({ type: 'update', uuid: r2.results[0]!.uuid!, title: 'B' })]);

  assert.equal(r1.serverVersion, 1);
  assert.equal(r2.serverVersion, 3);
  assert.equal(r3.serverVersion, 4);
  const seqs = (await getOps(app)).ops.map((o) => o.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4]);

  await app.close();
});

test('LWW: older update to the same field arriving later is stale', async () => {
  const { app } = makeApp();
  const created = await postOps(app, [createBookmark('original')]);
  const uuid = created.results[0]!.uuid!;

  await postOps(app, [op({ type: 'update', uuid, title: 'newer', timestamp: 9_000 })]);
  const late = await postOps(app, [op({ type: 'update', uuid, title: 'older', timestamp: 8_000 })]);

  assert.equal(late.results[0]!.status, 'stale');
  const { roots } = await getTree(app);
  assert.equal(roots[0]!.title, 'newer');
  // Stale ops are not logged.
  assert.equal((await getOps(app)).ops.length, 2);

  await app.close();
});

test('move and update touch different field groups and never conflict', async () => {
  const { app } = makeApp();
  const created = await postOps(app, [createFolder('F'), createBookmark('b')]);
  const folderUuid = created.results[0]!.uuid!;
  const uuid = created.results[1]!.uuid!;

  // A newer rename must not block an older (concurrent) move, and vice versa.
  await postOps(app, [op({ type: 'update', uuid, title: 'renamed', timestamp: 9_000 })]);
  const move = await postOps(app, [
    op({ type: 'move', uuid, parentUuid: folderUuid, sortOrder: 'c5', timestamp: 8_000 }),
  ]);
  assert.equal(move.results[0]!.status, 'applied');

  const update = await postOps(app, [
    op({ type: 'update', uuid, title: 'renamed again', timestamp: 8_500 }),
  ]);
  assert.equal(update.results[0]!.status, 'stale'); // older than the 9_000 rename

  const { roots } = await getTree(app);
  const child = roots[0]!.children![0]!;
  assert.equal(child.title, 'renamed');
  assert.equal(child.parentUuid, folderUuid);
  assert.equal(child.sortOrder, 'c5');

  await app.close();
});

test('delete is soft and cascades to descendants', async () => {
  const { app, db } = makeApp();
  const created = await postOps(app, [createFolder('F')]);
  const folderUuid = created.results[0]!.uuid!;
  const child = await postOps(app, [createBookmark('inside', { parentUuid: folderUuid })]);
  const childUuid = child.results[0]!.uuid!;
  await postOps(app, [createBookmark('outside')]);

  await postOps(app, [op({ type: 'delete', uuid: folderUuid })]);

  const { roots } = await getTree(app);
  assert.deepEqual(
    roots.map((r) => r.title),
    ['outside'],
  );

  // Soft: rows survive with deleted_at set, nothing is purged.
  const rows = db.select().from(bookmarks).all();
  assert.equal(rows.length, 3);
  for (const uuid of [folderUuid, childUuid]) {
    assert.ok(rows.find((r) => r.uuid === uuid)!.deletedAt !== null);
  }

  // New ops referencing the deleted folder as parent are rejected.
  const rejected = await postOps(app, [createBookmark('late', { parentUuid: folderUuid })]);
  assert.equal(rejected.results[0]!.status, 'rejected');

  await app.close();
});

test('GET /api/ops?since= paginates by server seq', async () => {
  const { app } = makeApp();
  await postOps(app, [createBookmark('a'), createBookmark('b'), createBookmark('c')]);

  const all = await getOps(app, 0);
  assert.equal(all.ops.length, 3);
  assert.equal(all.serverVersion, 3);

  const tail = await getOps(app, 2);
  assert.deepEqual(
    tail.ops.map((o) => o.seq),
    [3],
  );
  assert.equal((await getOps(app, 3)).ops.length, 0);

  await app.close();
});

test('replaying the op log from version 0 reconstructs the tree', async () => {
  const { app, db } = makeApp();
  const created = await postOps(app, [createFolder('F'), createBookmark('a'), createBookmark('b')]);
  const [folderUuid, aUuid, bUuid] = created.results.map((r) => r.uuid!);
  await postOps(app, [
    op({ type: 'move', uuid: aUuid!, parentUuid: folderUuid!, sortOrder: 'm0' }),
    op({ type: 'update', uuid: aUuid!, title: 'A renamed' }),
    op({ type: 'delete', uuid: bUuid! }),
  ]);

  const { ops } = await getOps(app, 0);
  const replayDb = createDb(':memory:');
  applyOps(replayDb, ops);

  assert.deepEqual(buildTree(replayDb), buildTree(db));
  await app.close();
});

test('invalid ops are rejected per-op, malformed batches with 400', async () => {
  const { app } = makeApp();

  const res = await app.inject({
    method: 'POST',
    url: '/api/ops',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { ops: [{ type: 'create', title: 'no opId' }] },
  });
  assert.equal(res.statusCode, 400);

  const results = await postOps(app, [
    op({ type: 'update', uuid: 'no-such-uuid', title: 'x' }),
    createBookmark('orphan', { parentUuid: 'no-such-parent' }),
  ]);
  assert.deepEqual(
    results.results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(results.serverVersion, 0);

  await app.close();
});

test('moving a folder under its own descendant is rejected', async () => {
  const { app } = makeApp();
  const created = await postOps(app, [createFolder('outer')]);
  const outer = created.results[0]!.uuid!;
  const inner = (await postOps(app, [createFolder('inner', { parentUuid: outer })])).results[0]!
    .uuid!;

  const res = await postOps(app, [
    op({ type: 'move', uuid: outer, parentUuid: inner, sortOrder: 'a0' }),
  ]);
  assert.equal(res.results[0]!.status, 'rejected');

  await app.close();
});

test('bookmark tree children are ordered by sortOrder', async () => {
  const { app } = makeApp();
  await postOps(app, [
    createBookmark('third', { sortOrder: 'c0' }),
    createBookmark('first', { sortOrder: 'a0' }),
    createBookmark('second', { sortOrder: 'b0' }),
  ]);
  const { roots } = await getTree(app);
  assert.deepEqual(
    roots.map((r: BookmarkNode) => r.title),
    ['first', 'second', 'third'],
  );
  await app.close();
});
