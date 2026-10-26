import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { createHarness } from '../testing/harness.js';
import { FakeSyncServer } from '../testing/fakeServer.js';

test('Edge internal roots stay out of the cloud, including later edits', async () => {
  const fake = new FakeBookmarks(['Favorites bar', 'Other favourites', 'Workspaces', 'Deleted']);
  await fake.create({ parentId: '1', title: 'Daily', url: 'https://daily.example/' });
  await fake.create({ parentId: '2', title: 'Anthropic', url: 'https://anthropic.example/' });
  const workspace = await fake.create({ parentId: '3', title: 'Imported bookmarks' });
  await fake.create({ parentId: workspace.id, title: 'Daily', url: 'https://daily.example/' });
  await fake.create({ parentId: '4', title: 'Old', url: 'https://old.example/' });
  const h = createHarness({ fake });

  await h.engine.sync({ reconcile: true });
  assert.deepEqual(
    (await h.server.getBookmarks()).roots.map((root) => root.title),
    ['Favorites bar'],
  );

  await fake.create({ parentId: '3', title: 'Workspace only', url: 'https://ws.example/' });
  await h.engine.idle();
  await h.engine.sync({ force: true, reconcile: true });
  assert.equal((await h.server.getBookmarks()).roots.length, 1);
  assert.equal((await h.engine.status()).queueDepth, 0);
});

test('Vivaldi keeps its hidden roots untouched and syncs visible folders', async () => {
  const edge = new FakeBookmarks(['Favorites bar', 'Other favourites', 'Workspaces']);
  for (const title of ['Enora', 'Privat', 'gjessing.io']) {
    const folder = await edge.create({ parentId: '1', title });
    await edge.create({ parentId: folder.id, title: 'Daily', url: 'https://daily.example/' });
  }
  await edge.create({ parentId: '2', title: 'Anthropic', url: 'https://anthropic.example/' });
  const ws = await edge.create({ parentId: '3', title: 'Imported bookmarks' });
  await edge.create({ parentId: ws.id, title: 'Daily', url: 'https://daily.example/' });
  const origin = createHarness({ fake: edge });
  await origin.engine.sync();

  const vivaldi = new FakeBookmarks(['Bookmarks bar', 'Other bookmarks', 'Trash']);
  await vivaldi.create({ parentId: '2', title: 'Local hidden', url: 'https://hidden.example/' });
  const joiner = createHarness({ fake: vivaldi, server: origin.server });
  for (let i = 0; i < 2; i += 1) await joiner.engine.sync({ force: true, reconcile: true });

  assert.deepEqual(
    (await vivaldi.getChildren('2')).map((node) => node.title),
    ['Local hidden'],
  );
  assert.deepEqual(
    (await vivaldi.getChildren('3')).map((node) => node.title),
    [],
  );
  assert.deepEqual(
    (await vivaldi.getChildren('1')).map((node) => node.title),
    ['Enora', 'Privat', 'gjessing.io'],
  );
  assert.equal((await joiner.engine.status()).queueDepth, 0);
});

test('existing mappings and queued creates in excluded roots stop uploading', async () => {
  const fake = new FakeBookmarks(['Bookmarks bar', 'Other bookmarks', 'Trash']);
  const hidden = await fake.create({ parentId: '2', title: 'Workspaces' });
  const h = createHarness({ fake });
  await h.stores.mappings.put({
    browserId: '2',
    uuid: 'old-hidden-root',
    parentBrowserId: '0',
    sortOrder: 'U',
  });
  await h.stores.mappings.put({
    browserId: hidden.id,
    uuid: 'old-hidden-child',
    parentBrowserId: '2',
    sortOrder: 'U',
  });
  await h.stores.queue.enqueue({
    opId: 'queued-hidden',
    timestamp: 1,
    kind: 'create',
    browserId: hidden.id,
    parentBrowserId: '2',
    nodeType: 'folder',
    title: hidden.title,
    sortOrder: 'U',
  });

  await h.engine.sync();
  assert.equal(await h.stores.mappings.get('2'), undefined);
  assert.equal(await h.stores.mappings.get(hidden.id), undefined);
  assert.equal((await h.engine.status()).queueDepth, 0);
  assert.deepEqual(
    (await h.server.getBookmarks()).roots.map((root) => root.title),
    ['Bookmarks bar'],
  );
  assert.deepEqual(
    (await fake.getChildren('2')).map((node) => node.title),
    ['Workspaces'],
  );
});

test('historical hidden roots with copied sections do not replay into Edge', async () => {
  const server = new FakeSyncServer();
  let serial = 0;
  const create = async (parentUuid: string | null, title: string): Promise<string> => {
    const result = await server.postOps([
      {
        opId: `legacy-${++serial}`,
        deviceId: 'legacy',
        timestamp: serial,
        type: 'create',
        parentUuid,
        nodeType: 'folder',
        title,
        sortOrder: 'i',
      },
    ]);
    const uuid = result.results[0]?.uuid;
    assert.ok(uuid);
    return uuid;
  };
  await create(null, 'Bookmarks bar');
  const hidden = await create(null, 'Other bookmarks');
  await create(hidden, 'Workspaces');
  await create(hidden, 'Other favourites');
  const ws = await create(null, 'Workspaces');
  await create(ws, 'Imported bookmarks');
  const other = await create(null, 'Other favourites');
  await create(other, 'Anthropic');

  const fake = new FakeBookmarks(['Favorites bar', 'Other favourites', 'Workspaces']);
  const h = createHarness({ fake, server });
  await h.engine.sync({ reconcile: true });
  assert.deepEqual(
    (await fake.getChildren('1')).map((node) => node.title),
    [],
  );
  assert.deepEqual(
    (await fake.getChildren('2')).map((node) => node.title),
    [],
  );
  assert.deepEqual(
    (await fake.getChildren('3')).map((node) => node.title),
    [],
  );
  assert.equal((await h.engine.status()).lastError, undefined);

  const vivaldi = new FakeBookmarks(['Bookmarks bar', 'Other bookmarks', 'Trash']);
  const v = createHarness({ fake: vivaldi, server });
  await v.engine.sync({ reconcile: true });
  assert.deepEqual(
    (await vivaldi.getChildren('1')).map((node) => node.title),
    [],
  );
  assert.deepEqual(
    (await vivaldi.getChildren('2')).map((node) => node.title),
    [],
  );
  assert.equal((await v.engine.status()).lastError, undefined);
});

test('moving a folder across an excluded root removes and restores its sync', async () => {
  const fake = new FakeBookmarks(['Favorites bar', 'Other favourites', 'Workspaces']);
  const folder = await fake.create({ parentId: '1', title: 'Enora' });
  await fake.create({ parentId: folder.id, title: 'Daily', url: 'https://daily.example/' });
  const h = createHarness({ fake });
  await h.engine.sync();

  await fake.move(folder.id, { parentId: '3' });
  await h.engine.idle();
  await h.engine.sync({ force: true });
  assert.deepEqual((await h.server.getBookmarks()).roots[0]?.children, []);

  await fake.move(folder.id, { parentId: '1' });
  await h.engine.idle();
  await h.engine.sync({ force: true });
  const restored = (await h.server.getBookmarks()).roots[0]?.children ?? [];
  assert.deepEqual(
    restored.map((node) => node.title),
    ['Enora'],
  );
  assert.deepEqual(
    restored[0]?.children?.map((node) => node.title),
    ['Daily'],
  );
});

test('Vivaldi hidden copies identify the excluded root when Trash is not exposed', async () => {
  const fake = new FakeBookmarks(['Bookmarks bar', 'Other bookmarks']);
  await fake.create({ parentId: '1', title: 'Enora' });
  await fake.create({ parentId: '2', title: 'Workspaces' });
  await fake.create({ parentId: '2', title: 'Other favourites' });
  const h = createHarness({ fake });
  await h.engine.sync();
  assert.deepEqual(
    (await h.server.getBookmarks()).roots.map((root) => root.title),
    ['Bookmarks bar'],
  );
});

test('a localized Edge syncs only its favorites bar, whatever the root titles', async () => {
  const fake = new FakeBookmarks(
    ['Favorittlinje', 'Andre favoritter', 'Arbeidsområder', 'Slettet'],
    {
      browser: 'edge',
    },
  );
  await fake.create({ parentId: '1', title: 'Daily', url: 'https://daily.example/' });
  await fake.create({ parentId: '2', title: 'Hidden', url: 'https://hidden.example/' });
  const ws = await fake.create({ parentId: '3', title: 'Workspaces' });
  await fake.create({ parentId: ws.id, title: 'Daily', url: 'https://daily.example/' });
  const h = createHarness({ fake });

  await h.engine.sync({ reconcile: true });
  await fake.create({ parentId: '2', title: 'Later', url: 'https://later.example/' });
  await h.engine.idle();
  await h.engine.sync({ force: true, reconcile: true });

  const roots = (await h.server.getBookmarks()).roots;
  assert.deepEqual(
    roots.map((root) => root.title),
    ['Favorittlinje'],
  );
  assert.deepEqual(
    roots[0]?.children?.map((node) => node.title),
    ['Daily'],
  );
  assert.equal((await h.engine.status()).queueDepth, 0);
});

test('a localized Edge root uploaded by an older version is dropped, then deletable', async () => {
  // Before the fix the extension only knew English titles, so a Norwegian
  // Edge uploaded "Andre favoritter" as a root of its own.
  const fake = new FakeBookmarks(['Favorittlinje', 'Andre favoritter']);
  await fake.create({ parentId: '1', title: 'Daily', url: 'https://daily.example/' });
  await fake.create({ parentId: '2', title: 'Workspaces' });
  const h = createHarness({ fake });
  await h.engine.sync({ reconcile: true });
  const leaked = (await h.server.getBookmarks()).roots.find(
    (root) => root.title === 'Andre favoritter',
  );
  assert.ok(leaked, 'the old behaviour uploads the localized root');

  // Extension update: the browser is now recognised as Edge.
  fake.options.browser = 'edge';
  await h.engine.sync({ force: true, reconcile: true });
  const version = (await h.server.getOps(0, 1000)).serverVersion;

  // Deleting the leaked cloud root leaves Edge's own root alone and is not
  // re-uploaded.
  await h.server.postOps([
    {
      opId: 'admin-1',
      deviceId: 'admin',
      timestamp: Date.now(),
      type: 'delete',
      uuid: leaked.uuid,
    },
  ]);
  for (let i = 0; i < 2; i += 1) await h.engine.sync({ force: true, reconcile: true });

  assert.deepEqual(
    (await fake.getChildren('2')).map((node) => node.title),
    ['Workspaces'],
  );
  assert.deepEqual(
    (await h.server.getBookmarks()).roots.map((root) => root.title),
    ['Favorittlinje'],
  );
  const device = await h.engine.deviceId();
  const after = (await h.server.getOps(version, 1000)).ops;
  assert.deepEqual(
    after.filter((op) => op.deviceId === device),
    [],
  );
  assert.equal((await h.engine.status()).lastError, undefined);
});

test('deleting a cloud root never removes the browser-owned root', async () => {
  const fake = new FakeBookmarks(['Favorites bar']);
  const h = createHarness({ fake });
  await h.engine.sync();
  const root = (await h.server.getBookmarks()).roots[0];
  assert.ok(root);
  await h.server.postOps([
    {
      opId: 'remove-cloud-root',
      deviceId: 'admin',
      timestamp: Date.now(),
      type: 'delete',
      uuid: root.uuid,
    },
  ]);
  await h.engine.sync({ force: true });
  assert.equal((await fake.getTree())[0]?.children?.[0]?.title, 'Favorites bar');
  assert.equal((await h.engine.status()).lastError, undefined);
});
