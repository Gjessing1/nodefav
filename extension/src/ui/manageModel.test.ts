import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookmarkNode, TrashItem } from '@nodefav/shared';
import {
  countDescendants,
  dropDestination,
  emptyFolderCandidates,
  endKey,
  folderChoices,
  indexTree,
  searchTree,
  shiftKey,
  sortNodes,
  trashGroups,
} from './manageModel.js';

function node(
  uuid: string,
  sortOrder: string,
  fields: Partial<BookmarkNode> = {},
  children?: BookmarkNode[],
): BookmarkNode {
  return {
    uuid,
    parentUuid: null,
    type: children ? 'folder' : 'bookmark',
    title: uuid,
    url: children ? null : `https://example.com/${uuid}`,
    sortOrder,
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    ...(children ? { children } : {}),
    ...fields,
  };
}

const tree = (): BookmarkNode[] => [
  node('bar', 'i', { title: 'Bar' }, [
    node('privat', 'r', { title: 'Privat' }, [
      node('news', 'i', { title: 'Nyheter' }, [node('verge', 'i', { title: 'The Verge' })]),
      node('bank', 'r', { title: 'Sparebank', url: 'https://sparebank1.no' }),
    ]),
    node('work', 'i', { title: 'Enora' }, []),
  ]),
  node('other', 'r', { title: 'Other' }, []),
];

test('siblings sort by key with uuid tie-break', () => {
  const sorted = sortNodes([node('b', 'k'), node('a', 'k'), node('c', 'b')]);
  assert.deepEqual(
    sorted.map((n) => n.uuid),
    ['c', 'a', 'b'],
  );
});

test('endKey places after the last sibling, ignoring the moved node itself', () => {
  const privat = tree()[0]!.children![0]!;
  assert.ok(endKey(privat) > 'r');
  assert.ok(endKey(privat, 'bank') > 'i');
  assert.ok(endKey(node('empty', 'i', {}, [])).length > 0);
});

test('shiftKey swaps one step and stops at the edges', () => {
  const privat = tree()[0]!.children![0]!;
  const up = shiftKey(privat, 'bank', -1)!;
  assert.ok(up < 'i');
  const down = shiftKey(privat, 'news', 1)!;
  assert.ok(down > 'r');
  assert.equal(shiftKey(privat, 'news', -1), null);
  assert.equal(shiftKey(privat, 'bank', 1), null);
  assert.equal(shiftKey(privat, 'missing', 1), null);
});

test('drop destinations reorder siblings, move into folders, and reject cycles', () => {
  const roots = tree();
  const before = dropDestination(roots, 'bank', 'news', 'before');
  assert.equal(before?.parentUuid, 'privat');
  assert.ok(before!.sortOrder < 'i');
  const inside = dropDestination(roots, 'bank', 'work', 'inside');
  assert.equal(inside?.parentUuid, 'work');
  assert.ok(inside?.sortOrder);
  assert.equal(dropDestination(roots, 'privat', 'news', 'inside'), null);
  assert.equal(dropDestination(roots, 'bar', 'work', 'inside'), null);
  assert.equal(dropDestination(roots, 'bank', 'bank', 'before'), null);
});

test('folder choices are paths in tree order, excluding the moved subtree', () => {
  assert.deepEqual(
    folderChoices(tree()).map((choice) => choice.label),
    ['Bar', 'Bar / Enora', 'Bar / Privat', 'Bar / Privat / Nyheter', 'Other'],
  );
  assert.deepEqual(
    folderChoices(tree(), 'privat').map((choice) => choice.uuid),
    ['bar', 'work', 'other'],
  );
});

test('index maps every node to its parent', () => {
  const index = indexTree(tree());
  assert.equal(index.get('verge')?.parent?.uuid, 'news');
  assert.equal(index.get('bar')?.parent, null);
  assert.equal(index.size, 7);
});

test('search matches title or URL, case-insensitively, with its folder path', () => {
  assert.deepEqual(
    searchTree(tree(), 'VERGE').map((hit) => [hit.node.uuid, hit.path.join('/')]),
    [['verge', 'Bar/Privat/Nyheter']],
  );
  assert.deepEqual(
    searchTree(tree(), 'sparebank1').map((hit) => hit.node.uuid),
    ['bank'],
  );
  assert.deepEqual(searchTree(tree(), '  '), []);
});

test('descendant count covers the whole subtree', () => {
  assert.equal(countDescendants(tree()[0]!), 5);
  assert.equal(countDescendants(tree()[1]!), 0);
});

test('empty-folder cleanup chooses topmost empty subtrees and protects active roots', () => {
  const roots = [
    node('bar', 'i', { title: 'Bar' }, [
      node('empty-parent', 'i', {}, [node('empty-child', 'i', {}, [])]),
      node('with-link', 'r', {}, [node('link', 'i')]),
      node('empty-after-link', 's', {}, []),
    ]),
    node('legacy', 'r', { title: 'Workspaces' }, [node('old-child', 'i', {}, [])]),
    node('empty-active-root', 's', { title: 'Mobile bookmarks' }, []),
  ];
  assert.deepEqual(
    emptyFolderCandidates(roots, (root) => root.title === 'Workspaces').map(
      (folder) => folder.uuid,
    ),
    ['empty-parent', 'empty-after-link', 'legacy'],
  );
});

test('trash groups one entry per deleted subtree, newest first', () => {
  const item = (uuid: string, parentUuid: string | null, deletedAt: number): TrashItem => ({
    uuid,
    parentUuid,
    type: 'bookmark',
    title: uuid,
    url: null,
    sortOrder: 'i',
    deletedAt,
  });
  const groups = trashGroups([
    item('folder', 'live-parent', 10),
    item('child', 'folder', 10),
    item('grandchild', 'child', 10),
    item('lonely', 'live-parent', 20),
    item('orphan', 'purged', 5),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.item.uuid, group.descendants]),
    [
      ['lonely', 0],
      ['folder', 2],
      ['orphan', 0],
    ],
  );
});
