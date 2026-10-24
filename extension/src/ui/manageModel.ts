import type { BookmarkNode, TrashItem } from '@nodefav/shared';
import { keyBetween } from '../sync/order.js';

/**
 * Pure helpers behind the admin page (manage.html): ordering, folder pickers,
 * search and trash grouping over the cloud tree. Kept free of DOM and chrome
 * APIs so they are unit-testable.
 */

/** Sibling order: fractional key, uuid as the deterministic tie-break. */
export function sortNodes<T extends { sortOrder: string; uuid: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.uuid.localeCompare(b.uuid) : a.sortOrder < b.sortOrder ? -1 : 1,
  );
}

/** Key that places a new or moved node last in `folder`. */
export function endKey(folder: BookmarkNode, exceptUuid?: string): string {
  const siblings = sortNodes((folder.children ?? []).filter((node) => node.uuid !== exceptUuid));
  return keyBetween(siblings.at(-1)?.sortOrder ?? null, null);
}

/**
 * Key that swaps `uuid` one step up (-1) or down (+1) among its siblings;
 * null when it is already at that edge.
 */
export function shiftKey(parent: BookmarkNode, uuid: string, direction: -1 | 1): string | null {
  const siblings = sortNodes(parent.children ?? []);
  const index = siblings.findIndex((node) => node.uuid === uuid);
  const neighbor = siblings[index + direction];
  if (index === -1 || neighbor === undefined) return null;
  const [low, high] =
    direction === -1
      ? [siblings[index - 2]?.sortOrder ?? null, neighbor.sortOrder]
      : [neighbor.sortOrder, siblings[index + 2]?.sortOrder ?? null];
  return keyBetween(low, high);
}

export interface FolderChoice {
  uuid: string;
  /** "Favorites bar / 2 Privat / Nyheter" */
  label: string;
}

/** Every live folder as a move target, minus `exclude` and its subtree (no cycles). */
export function folderChoices(roots: BookmarkNode[], exclude?: string): FolderChoice[] {
  const choices: FolderChoice[] = [];
  const walk = (node: BookmarkNode, path: string[]): void => {
    if (node.type !== 'folder' || node.uuid === exclude) return;
    const label = [...path, node.title];
    choices.push({ uuid: node.uuid, label: label.join(' / ') });
    for (const child of sortNodes(node.children ?? [])) walk(child, label);
  };
  for (const root of sortNodes(roots)) walk(root, []);
  return choices;
}

/** Map of uuid → { node, parent } for the whole tree. */
export function indexTree(
  roots: BookmarkNode[],
): Map<string, { node: BookmarkNode; parent: BookmarkNode | null }> {
  const index = new Map<string, { node: BookmarkNode; parent: BookmarkNode | null }>();
  const walk = (node: BookmarkNode, parent: BookmarkNode | null): void => {
    index.set(node.uuid, { node, parent });
    for (const child of node.children ?? []) walk(child, node);
  };
  for (const root of roots) walk(root, null);
  return index;
}

export interface SearchHit {
  node: BookmarkNode;
  /** Folder titles from the root down to the hit's parent. */
  path: string[];
}

/** Case-insensitive title/URL search; empty query → no hits. */
export function searchTree(roots: BookmarkNode[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hits: SearchHit[] = [];
  const walk = (node: BookmarkNode, path: string[]): void => {
    if (
      node.title.toLowerCase().includes(needle) ||
      (node.url ?? '').toLowerCase().includes(needle)
    ) {
      hits.push({ node, path });
    }
    for (const child of sortNodes(node.children ?? [])) walk(child, [...path, node.title]);
  };
  for (const root of sortNodes(roots)) walk(root, []);
  return hits;
}

/** Bookmarks + folders below `node` (not counting itself). */
export function countDescendants(node: BookmarkNode): number {
  return (node.children ?? []).reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

export interface TrashGroup {
  item: TrashItem;
  /** Trashed nodes below it that a restore brings back along with it. */
  descendants: number;
}

/**
 * Trash as the user thinks of it: one entry per deleted subtree (a node whose
 * parent is not itself in the trash), newest deletion first.
 */
export function trashGroups(items: TrashItem[]): TrashGroup[] {
  const byUuid = new Map(items.map((item) => [item.uuid, item]));
  const childCount = new Map<string, number>();
  for (const item of items) {
    // Attribute each trashed node to its nearest trashed top-level ancestor.
    let top = item;
    const seen = new Set<string>();
    while (top.parentUuid !== null && byUuid.has(top.parentUuid) && !seen.has(top.uuid)) {
      seen.add(top.uuid);
      top = byUuid.get(top.parentUuid)!;
    }
    if (top !== item) childCount.set(top.uuid, (childCount.get(top.uuid) ?? 0) + 1);
  }
  return items
    .filter((item) => item.parentUuid === null || !byUuid.has(item.parentUuid))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .map((item) => ({ item, descendants: childCount.get(item.uuid) ?? 0 }));
}
