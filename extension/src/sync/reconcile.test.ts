import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { createHarness, restartWorker, serverSnapshot } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';

/**
 * Drift scenarios: every test simulates missed bookmark events (listeners
 * dropped by a dead worker while the user keeps editing) or a skipped remote
 * apply, then expects a forced reconciliation to converge both sides again.
 */

async function seedTree(fake: FakeBookmarks): Promise<void> {
  const dev = await fake.create({ parentId: '1', title: 'Dev' });
  await fake.create({ parentId: dev.id, title: 'MDN', url: 'https://developer.mozilla.org/' });
  await fake.create({ parentId: '1', title: 'News', url: 'https://news.ycombinator.com/' });
  await fake.create({ parentId: '2', title: 'Archive' });
}

async function syncedHarness(): Promise<Harness> {
  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake });
  await h.engine.sync();
  await h.engine.idle();
  assert.equal((await h.engine.status()).queueDepth, 0);
  return h;
}

async function findByTitle(fake: FakeBookmarks, parentId: string, title: string) {
  const child = (await fake.getChildren(parentId)).find((node) => node.title === title);
  assert.ok(child, `no "${title}" under ${parentId}`);
  return child as BookmarkNodeLite;
}

test('clean state: reconcile finds nothing and records the pass', async () => {
  const h = await syncedHarness();

  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  const status = await h.engine.status();
  assert.ok(status.lastReconcileAt !== undefined);
  assert.equal(status.lastDrift, undefined);
  assert.equal(status.lastError, undefined);
});

test('missed local create: the unsynced subtree is re-uploaded', async () => {
  let h = await syncedHarness();

  h.fake.resetListeners(); // worker died; edits below produce no events
  const ghost = await h.fake.create({ parentId: '1', title: 'Ghost' });
  await h.fake.create({ parentId: ghost.id, title: 'Boo', url: 'https://boo.example/' });
  h = restartWorker(h);

  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  assert.deepEqual(await serverSnapshot(h.server), h.fake.snapshot());
  const status = await h.engine.status();
  assert.equal(status.queueDepth, 0);
  assert.match(status.lastDrift ?? '', /re-uploaded 1 unsynced local subtree/);
});

test('missed local rename: cloud wins and the title is restored', async () => {
  let h = await syncedHarness();
  const news = await findByTitle(h.fake, '1', 'News');

  h.fake.resetListeners();
  await h.fake.update(news.id, { title: 'Hacked' });
  h = restartWorker(h);

  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  assert.equal((await h.fake.get(news.id))?.title, 'News');
  assert.deepEqual(await serverSnapshot(h.server), h.fake.snapshot());
  const status = await h.engine.status();
  assert.match(status.lastDrift ?? '', /repaired 1 drifted item/);
  assert.doesNotMatch(status.lastDrift ?? '', /residual/);
});

test('missed local delete: the node is re-materialized from the cloud', async () => {
  let h = await syncedHarness();
  const news = await findByTitle(h.fake, '1', 'News');

  h.fake.resetListeners();
  await h.fake.removeTree(news.id);
  h = restartWorker(h);

  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  await findByTitle(h.fake, '1', 'News'); // back, under a fresh browser id
  assert.deepEqual(await serverSnapshot(h.server), h.fake.snapshot());
});

test('missed local move: the node returns to its cloud position', async () => {
  let h = await syncedHarness();
  const news = await findByTitle(h.fake, '1', 'News');

  h.fake.resetListeners();
  await h.fake.move(news.id, { parentId: '2', index: 0 });
  h = restartWorker(h);

  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  assert.equal((await h.fake.get(news.id))?.parentId, '1');
  assert.deepEqual(await serverSnapshot(h.server), h.fake.snapshot());
  assert.match((await h.engine.status()).lastDrift ?? '', /repaired/);
});

test('skipped remote delete: locally-extra node is removed, cloud wins', async () => {
  const a = await syncedHarness();
  const b = createHarness({ server: a.server });
  await b.engine.sync();
  await b.engine.idle();

  const newsOnB = await findByTitle(b.fake, '1', 'News');
  await b.fake.removeTree(newsOnB.id);
  await b.engine.sync();
  await b.engine.idle();

  // Simulate device A skipping the delete: jump the cursor past it.
  await a.stores.meta.set('cursor', a.server.opCount());
  await a.engine.sync({ force: true, reconcile: true });
  await a.engine.idle();

  const children = await a.fake.getChildren('1');
  assert.ok(!children.some((node) => node.title === 'News'));
  assert.deepEqual(await serverSnapshot(a.server), a.fake.snapshot());
  assert.deepEqual(a.fake.snapshot(), b.fake.snapshot());
});

test('a busy queue skips reconciliation instead of misreporting drift', async () => {
  const h = await syncedHarness();
  h.server.offline = true;
  await h.fake.create({ parentId: '1', title: 'Offline', url: 'https://off.example/' });
  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();

  const status = await h.engine.status();
  assert.ok(status.queueDepth > 0);
  assert.equal(status.lastDrift, undefined);

  h.server.offline = false;
  await h.engine.sync({ force: true, reconcile: true });
  await h.engine.idle();
  assert.deepEqual(await serverSnapshot(h.server), h.fake.snapshot());
  assert.equal((await h.engine.status()).lastDrift, undefined);
});
