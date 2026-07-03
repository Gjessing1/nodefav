import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { createHarness, restartWorker, serverSnapshot } from '../testing/harness.js';

/** Pre-install content: created before any listeners exist. */
async function seedTree(fake: FakeBookmarks): Promise<void> {
  const dev = await fake.create({ parentId: '1', title: 'Dev' });
  await fake.create({ parentId: dev.id, title: 'MDN', url: 'https://developer.mozilla.org/' });
  await fake.create({ parentId: '1', title: 'News', url: 'https://news.ycombinator.com/' });
  await fake.create({ parentId: '2', title: 'Archive' });
}

test('initial upload: walks the native tree into an empty cloud', async () => {
  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake });

  await h.engine.sync();
  await h.engine.idle();

  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
  const status = await h.engine.status();
  assert.equal(status.initialized, true);
  assert.equal(status.queueDepth, 0);
  assert.equal(status.mappingCount, fake.nodeCount());
  assert.equal(status.lastError, undefined);
});

test('live edits: create, rename, move, delete each reach the cloud', async () => {
  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake });
  await h.engine.sync();

  const blog = await fake.create({
    parentId: '1',
    index: 0,
    title: 'Blog',
    url: 'https://blog.example/',
  });
  await h.engine.sync();
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());

  await fake.update(blog.id, { title: 'Blog!', url: 'https://blog.example/feed' });
  await h.engine.sync();
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());

  await fake.move(blog.id, { parentId: '2', index: 0 });
  await h.engine.sync();
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());

  await fake.removeTree(blog.id);
  await h.engine.sync();
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
  assert.equal((await h.engine.status()).queueDepth, 0);
});

test('deleting a folder cascades and cleans descendant mappings', async () => {
  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake });
  await h.engine.sync();
  const before = (await h.engine.status()).mappingCount;

  const devFolder = (await fake.getChildren('1'))[0];
  assert.ok(devFolder && devFolder.title === 'Dev');
  await fake.removeTree(devFolder.id);
  await h.engine.sync();

  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
  // Dev + MDN gone from the mapping shadow.
  assert.equal((await h.engine.status()).mappingCount, before - 2);
});

test('offline edits queue durably, back off, and drain on reconnect in order', async () => {
  const fake = new FakeBookmarks();
  const h = createHarness({ fake });
  await h.engine.sync();

  h.server.offline = true;
  const a = await fake.create({ parentId: '1', title: 'A', url: 'https://a.example/' });
  await fake.update(a.id, { title: 'A2' });
  const f = await fake.create({ parentId: '2', title: 'F' });
  await fake.move(a.id, { parentId: f.id, index: 0 });
  await h.engine.sync();

  let status = await h.engine.status();
  assert.ok(status.lastError, 'failure recorded');
  assert.equal(status.queueDepth, 4);

  // Backoff: an unforced sync while failing must not hit the server again.
  const callsBefore = h.server.postOpsCalls;
  h.server.offline = false;
  await h.engine.sync();
  assert.equal(h.server.postOpsCalls, callsBefore);

  await h.engine.sync({ force: true });
  status = await h.engine.status();
  assert.equal(status.queueDepth, 0);
  assert.equal(status.lastError, undefined);
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
});

test('service-worker death with a full queue: the new worker uploads it', async () => {
  const fake = new FakeBookmarks();
  const h1 = createHarness({ fake });
  await h1.engine.sync();

  h1.server.offline = true;
  await fake.create({ parentId: '1', title: 'Queued', url: 'https://q.example/' });
  await h1.engine.sync().catch(() => {});

  const h2 = restartWorker(h1);
  h2.server.offline = false;
  await h2.engine.sync({ force: true });

  assert.equal((await h2.engine.status()).queueDepth, 0);
  assert.deepEqual(await serverSnapshot(h2.server), fake.snapshot());
});

test('crash between upload and queue removal: retry is idempotent', async () => {
  const fake = new FakeBookmarks();
  const h = createHarness({ fake });
  await h.engine.sync();

  await fake.create({ parentId: '1', title: 'Once', url: 'https://once.example/' });

  const originalRemove = h.stores.queue.remove.bind(h.stores.queue);
  let failNext = true;
  h.stores.queue.remove = (qids) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('sw died'));
    }
    return originalRemove(qids);
  };

  await h.engine.sync();
  assert.ok((await h.engine.status()).lastError);
  const opsAfterFirstTry = h.server.opCount();

  await h.engine.sync({ force: true });
  assert.equal(h.server.opCount(), opsAfterFirstTry, 'duplicate upload was not logged again');
  assert.equal((await h.engine.status()).queueDepth, 0);
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
});

test('parent and child created in one burst upload in dependency order', async () => {
  const fake = new FakeBookmarks();
  const h = createHarness({ fake });
  await h.engine.sync();
  const callsBefore = h.server.postOpsCalls;

  const folder = await fake.create({ parentId: '1', title: 'New folder' });
  const sub = await fake.create({ parentId: folder.id, title: 'Sub' });
  await fake.create({ parentId: sub.id, title: 'Deep', url: 'https://deep.example/' });
  await h.engine.sync();

  // Each level depends on the previous one's server-assigned uuid → three rounds.
  assert.equal(h.server.postOpsCalls - callsBefore, 3);
  assert.equal((await h.engine.status()).queueDepth, 0);
  assert.deepEqual(await serverSnapshot(h.server), fake.snapshot());
});

test('ops that can never resolve are dropped, not retried forever', async () => {
  const fake = new FakeBookmarks();
  const h = createHarness({ fake });
  await h.engine.sync();
  const opsBefore = h.server.opCount();

  await h.stores.queue.enqueue({
    opId: 'stale-op',
    timestamp: Date.now(),
    kind: 'update',
    browserId: 'no-such-node',
    title: 'ghost',
  });
  await h.engine.sync();

  assert.equal((await h.engine.status()).queueDepth, 0);
  assert.equal(h.server.opCount(), opsBefore);
});

test('refuses to initialize when both sides already have bookmarks', async () => {
  const seedServer = createHarness({});
  await seedServer.fake.create({ parentId: '1', title: 'Cloud', url: 'https://cloud.example/' });
  await seedServer.engine.sync();

  const fake = new FakeBookmarks();
  await seedTree(fake);
  const h = createHarness({ fake, server: seedServer.server });
  await h.engine.sync();

  const status = await h.engine.status();
  assert.equal(status.initialized, false);
  assert.match(status.lastError ?? '', /Phase 4/);
  assert.equal(status.queueDepth, 0);
});
