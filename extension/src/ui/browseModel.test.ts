import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { browseFolderPath, browseStartId } from './browseModel.js';

test('browse start skips a lone root and honors a chosen nested folder', async () => {
  const browser = new FakeBookmarks(['Favorites bar', 'Other favorites', 'Workspaces']);
  const folder = await browser.create({ parentId: '1', title: 'Daily' });
  const tree = await browser.getTree();
  assert.equal(browseStartId(tree, 'auto'), '1');
  assert.equal(browseStartId(tree, `folder:${folder.id}`), folder.id);
  assert.equal(browseStartId(tree, 'all'), null);
  assert.equal(browseStartId(tree, 'folder:deleted'), '1');
  assert.equal(browseStartId(tree, 'folder:2'), '1', 'excluded roots cannot be the start');
});

test('automatic start keeps all bookmarks when several roots are syncable', async () => {
  const browser = new FakeBookmarks(['Bookmarks bar', 'Other bookmarks']);
  assert.equal(browseStartId(await browser.getTree(), 'auto'), null);
});

test('breadcrumbs include the complete ancestry even for a nested start folder', async () => {
  const browser = new FakeBookmarks();
  const work = await browser.create({ parentId: '1', title: 'Work' });
  const daily = await browser.create({ parentId: work.id, title: 'Daily' });
  const tree = await browser.getTree();
  const currentId = browseStartId(tree, `folder:${daily.id}`);
  assert.deepEqual(
    browseFolderPath(tree, currentId).map((node) => [node.id, node.title]),
    [
      ['1', 'Bookmarks bar'],
      [work.id, 'Work'],
      [daily.id, 'Daily'],
    ],
  );
  assert.deepEqual(
    browseFolderPath(tree, '1').map((node) => node.id),
    ['1'],
  );
  assert.deepEqual(browseFolderPath(tree, null), []);
});

test('breadcrumbs follow renamed and moved folders and disappear for deleted folders', async () => {
  const browser = new FakeBookmarks();
  const folder = await browser.create({ parentId: '1', title: 'Old name' });
  await browser.update(folder.id, { title: 'New name' });
  await browser.move(folder.id, { parentId: '2' });
  assert.deepEqual(
    browseFolderPath(await browser.getTree(), folder.id).map((node) => node.title),
    ['Other bookmarks', 'New name'],
  );
  await browser.removeTree(folder.id);
  assert.deepEqual(browseFolderPath(await browser.getTree(), folder.id), []);
});

test('breadcrumbs never expose invisible roots, excluded roots or bookmark URLs', async () => {
  const browser = new FakeBookmarks(['Favorites bar', 'Other favorites', 'Workspaces']);
  const excludedFolder = await browser.create({ parentId: '2', title: 'Excluded' });
  const bookmark = await browser.create({
    parentId: '1',
    title: 'Link',
    url: 'https://example.com',
  });
  const tree = await browser.getTree();
  for (const id of ['0', '2', '3', 'missing', excludedFolder.id, bookmark.id]) {
    assert.deepEqual(browseFolderPath(tree, id), [], id);
  }
});
