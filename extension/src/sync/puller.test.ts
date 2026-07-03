import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookmarkNode, SyncOpBase } from '@nodefav/shared';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { createHarness, restartWorker, serverSnapshot } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';
import { META } from './context.js';
import { keyBetween } from './order.js';

/** Pre-install content: created before any listeners exist. */
async function seedTree(fake: FakeBookmarks): Promise<void> {
  const dev = await fake.create({ parentId: '1', title: 'Dev' });
  await fake.create({ parentId: dev.id, title: 'MDN', url: 'https://developer.mozilla.org/' });
  await fake.create({ parentId: '1', title: 'News', url: 'https://news.ycombinator.com/' });
  await fake.create({ parentId: '2', title: 'Archive' });
}

/** A harness whose seeded tree has completed its initial upload. */
async function syncedHarness(): Promise<Harness> {
  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake });
  await h.engine.sync();
  await h.engine.idle();
  return h;
}

let remoteOpSeq = 0;
/** Base fields of an op arriving from another device. */
function fromOtherDevice(): SyncOpBase {
  remoteOpSeq += 1;
  return { opId: `remote-${remoteOpSeq}`, deviceId: 'remote-device', timestamp: Date.now() };
}

function findNode(nodes: BookmarkNode[], title: string): BookmarkNode {
  for (const node of nodes) {
    if (node.title === title) return node;
    const hit = node.children && tryFind(node.children, title);
    if (hit) return hit;
  }
  throw new Error(`no node titled "${title}" in the server tree`);
}
function tryFind(nodes: BookmarkNode[], title: string): BookmarkNode | undefined {
  try {
    return findNode(nodes, title);
  } catch {
    return undefined;
  }
}

/** Two forced idle sync cycles; any echo leak would upload during these. */
async function settle(h: Harness): Promise<void> {
  await h.engine.sync({ force: true });
  await h.engine.idle();
  await h.engine.sync({ force: true });
  await h.engine.idle();
}

test('remote create, update, move and delete apply natively with zero echo ops', async () => {
  const h = await syncedHarness();
  const { roots } = await h.server.getBookmarks();
  const dev = findNode(roots, 'Dev');
  const mdn = findNode(roots, 'MDN');
  const archive = findNode(roots, 'Archive');

  await h.server.postOps([
    {
      ...fromOtherDevice(),
      type: 'create',
      parentUuid: dev.uuid,
      nodeType: 'bookmark',
      title: 'Remote',
      url: 'https://remote.example/',
      sortOrder: keyBetween(mdn.sortOrder, null),
    },
  ]);
  await h.engine.sync();
  await h.engine.idle();
  assert.deepEqual(h.fake.snapshot(), await serverSnapshot(h.server));

  const remote = findNode((await h.server.getBookmarks()).roots, 'Remote');
  await h.server.postOps([
    { ...fromOtherDevice(), type: 'update', uuid: remote.uuid, title: 'Remote!' },
    {
      ...fromOtherDevice(),
      type: 'move',
      uuid: remote.uuid,
      parentUuid: archive.uuid,
      sortOrder: keyBetween(null, null),
    },
    { ...fromOtherDevice(), type: 'delete', uuid: mdn.uuid },
  ]);
  await h.engine.sync();
  await h.engine.idle();
  assert.deepEqual(h.fake.snapshot(), await serverSnapshot(h.server));

  const opsAfterApply = h.server.opCount();
  await settle(h);
  assert.equal(h.server.opCount(), opsAfterApply, 'no echoed op reached the server');
  assert.equal(await h.stores.echoes.size(), 0, 'every expected echo was consumed');
  assert.equal((await h.engine.status()).queueDepth, 0);
  assert.equal((await h.engine.status()).cursor, opsAfterApply);
});

test('remote apply is idempotent: re-pulling the same ops changes nothing', async () => {
  const h = await syncedHarness();
  const { roots } = await h.server.getBookmarks();
  const dev = findNode(roots, 'Dev');
  const mdn = findNode(roots, 'MDN');

  await h.server.postOps([
    {
      ...fromOtherDevice(),
      type: 'create',
      parentUuid: dev.uuid,
      nodeType: 'folder',
      title: 'Once',
      sortOrder: keyBetween(mdn.sortOrder, null),
    },
  ]);
  await h.engine.sync();
  await h.engine.idle();

  // A lost cursor write (worker death after apply) re-delivers the batch.
  await h.stores.meta.set(META.cursor, 0);
  await settle(h);

  const bar = await h.fake.getChildren('1');
  const devNode = bar.find((n) => n.title === 'Dev');
  assert.ok(devNode);
  const onceCount = (await h.fake.getChildren(devNode.id)).filter((n) => n.title === 'Once').length;
  assert.equal(onceCount, 1, 'replayed create did not duplicate the node');
  assert.deepEqual(h.fake.snapshot(), await serverSnapshot(h.server));
});

test('fresh profile with a non-empty cloud materializes the full tree, then round-trips', async () => {
  const seeded = new FakeBookmarks();
  await seedTree(seeded);
  const origin = createHarness({ fake: seeded });
  await origin.engine.sync();
  await origin.engine.idle();

  const fake = new FakeBookmarks();
  const h = createHarness({ fake, server: origin.server });
  await h.engine.sync();
  await h.engine.idle();

  assert.deepEqual(fake.snapshot(), seeded.snapshot(), 'tree restored with ordering');
  const status = await h.engine.status();
  assert.equal(status.initialized, true);
  assert.equal(status.mappingCount, fake.nodeCount());
  assert.equal(status.queueDepth, 0);

  const opsAfterRestore = h.server.opCount();
  await settle(h);
  assert.equal(h.server.opCount(), opsAfterRestore, 'restore produced no echo ops');

  // Steady state after a restore: local and remote edits both round-trip.
  await fake.create({ parentId: '1', title: 'Local', url: 'https://local.example/' });
  await h.engine.sync();
  await h.engine.idle();
  assert.equal(h.server.opCount(), opsAfterRestore + 1);

  const news = findNode((await h.server.getBookmarks()).roots, 'News');
  await h.server.postOps([{ ...fromOtherDevice(), type: 'update', uuid: news.uuid, title: 'HN' }]);
  await h.engine.sync();
  await h.engine.idle();
  assert.deepEqual(fake.snapshot(), await serverSnapshot(h.server));
});

test('worker death between apply and echo: the echo hits a fresh worker and is suppressed', async () => {
  const h1 = await syncedHarness();
  const { roots } = await h1.server.getBookmarks();
  const bar = findNode(roots, 'Bookmarks bar');

  // Key past the existing children — colliding keys are a Phase 4 concern.
  let key = findNode(roots, 'News').sortOrder;
  const batch = Array.from({ length: 5 }, (_, i) => {
    key = keyBetween(key, null);
    return {
      ...fromOtherDevice(),
      type: 'create' as const,
      parentUuid: bar.uuid,
      nodeType: 'bookmark' as const,
      title: `Batch ${i}`,
      url: `https://batch.example/${i}`,
      sortOrder: key,
    };
  });
  await h1.server.postOps(batch);

  h1.fake.suspendEvents();
  await h1.engine.sync(); // applies remotely; the browser events never reach this worker
  const opsAfterApply = h1.server.opCount();
  const nodesAfterApply = h1.fake.nodeCount();

  const h2 = restartWorker(h1);
  h2.fake.resumeEvents(); // echoes arrive in the new worker
  await h2.engine.idle();
  await settle(h2);

  assert.equal(h2.server.opCount(), opsAfterApply, 'zero echo ops reached the server');
  assert.equal(h2.fake.nodeCount(), nodesAfterApply, 'no duplicates materialized');
  assert.deepEqual(h2.fake.snapshot(), await serverSnapshot(h2.server));
  assert.equal(await h2.stores.echoes.size(), 0);
  assert.equal((await h2.engine.status()).queueDepth, 0);
});

test('crash between native create and mapping write: retry adopts the orphan', async () => {
  const h = await syncedHarness();
  const { roots } = await h.server.getBookmarks();
  const bar = findNode(roots, 'Bookmarks bar');
  await h.server.postOps([
    {
      ...fromOtherDevice(),
      type: 'create',
      parentUuid: bar.uuid,
      nodeType: 'bookmark',
      title: 'Orphan',
      url: 'https://orphan.example/',
      sortOrder: keyBetween(findNode(roots, 'News').sortOrder, null),
    },
  ]);

  h.fake.suspendEvents();
  const originalPut = h.stores.mappings.put.bind(h.stores.mappings);
  let failNext = true;
  h.stores.mappings.put = (mapping) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('sw died'));
    }
    return originalPut(mapping);
  };

  await h.engine.sync(); // node created natively, then the mapping write "crashes"
  assert.ok((await h.engine.status()).lastError);
  const opsAfterApply = h.server.opCount();

  await h.engine.sync({ force: true }); // retry finds the persisted echo and adopts the orphan
  h.fake.resumeEvents();
  await h.engine.idle();
  await settle(h);

  const orphans = (await h.fake.getChildren('1')).filter((n) => n.title === 'Orphan');
  assert.equal(orphans.length, 1, 'exactly one node despite the retried create');
  assert.equal(h.server.opCount(), opsAfterApply, 'no echo op reached the server');
  assert.deepEqual(h.fake.snapshot(), await serverSnapshot(h.server));
  assert.equal((await h.engine.status()).queueDepth, 0);
});

test('interleaved local and remote bursts converge with no ping-pong', async () => {
  const h = await syncedHarness();
  const { roots } = await h.server.getBookmarks();
  const dev = findNode(roots, 'Dev');
  const mdn = findNode(roots, 'MDN');

  // Local burst: create, rename, nest, move — all before any sync runs.
  const folder = await h.fake.create({ parentId: '1', title: 'Burst' });
  const b1 = await h.fake.create({ parentId: folder.id, title: 'B1', url: 'https://b1.example/' });
  await h.fake.update(b1.id, { title: 'B1 renamed' });
  await h.fake.move(b1.id, { parentId: '2', index: 0 });
  await h.fake.update(folder.id, { title: 'Burst renamed' });

  // Remote burst landing in the same window.
  let key = mdn.sortOrder;
  await h.server.postOps([
    {
      ...fromOtherDevice(),
      type: 'create',
      parentUuid: dev.uuid,
      nodeType: 'bookmark',
      title: 'R1',
      url: 'https://r1.example/',
      sortOrder: (key = keyBetween(key, null)),
    },
    {
      ...fromOtherDevice(),
      type: 'create',
      parentUuid: dev.uuid,
      nodeType: 'folder',
      title: 'R2',
      sortOrder: keyBetween(key, null),
    },
    { ...fromOtherDevice(), type: 'update', uuid: mdn.uuid, title: 'MDN docs' },
  ]);

  await settle(h); // multi-round: nested local creates need their parents' uuids first
  assert.deepEqual(h.fake.snapshot(), await serverSnapshot(h.server));

  const opsConverged = h.server.opCount();
  await settle(h);
  assert.equal(h.server.opCount(), opsConverged, 'steady state generates no ops');
  assert.equal(await h.stores.echoes.size(), 0);
  assert.equal((await h.engine.status()).queueDepth, 0);
});
