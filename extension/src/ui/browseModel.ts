import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { syncableRoots } from '../sync/context.js';

/** Visible folder ancestry, excluding Chromium's invisible and unsynced roots. */
export function browseFolderPath(tree: BookmarkNodeLite[], id: string | null): BookmarkNodeLite[] {
  if (id === null) return [];
  const find = (nodes: BookmarkNodeLite[]): BookmarkNodeLite[] => {
    for (const node of nodes) {
      if (node.url) continue;
      if (node.id === id) return [node];
      const descendants = find(node.children ?? []);
      if (descendants.length > 0) return [node, ...descendants];
    }
    return [];
  };
  return find(syncableRoots(tree));
}

/** Folder IDs are local to this browser, so a vanished preference falls back to automatic. */
export function browseStartId(tree: BookmarkNodeLite[], preference: string): string | null {
  if (preference === 'all') return null;
  const roots = syncableRoots(tree);
  if (preference.startsWith('folder:')) {
    const id = preference.slice('folder:'.length);
    const find = (nodes: BookmarkNodeLite[]): boolean =>
      nodes.some((node) => !node.url && (node.id === id || find(node.children ?? [])));
    if (find(roots)) return id;
  }
  return roots.length === 1 ? roots[0]!.id : null;
}
