import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { BROWSER_ROOT_ID, META, isInitialized, syncableRoots } from './context.js';
import type { EngineEnv } from './context.js';
import { keyBetween } from './order.js';

/**
 * One-time setup, deciding between the three starting states:
 * - empty cloud → walk the native tree and enqueue it (initial upload);
 * - non-empty cloud + fresh profile → replay the op log from version 0
 *   (the pull path materializes the tree and builds the mappings);
 * - both non-empty → refuse; the merge chooser is Phase 4.
 * Returns false while initialization is impossible (unconfigured or refused).
 */
export async function ensureInitialized(ctx: EngineEnv): Promise<boolean> {
  if (await isInitialized(ctx)) return true;
  const api = await ctx.getApi();
  if (!api) return false;

  const cloud = await api.getBookmarks();
  const roots = syncableRoots(await ctx.bookmarks.getTree());
  const localHasContent = roots.some((root) => (root.children?.length ?? 0) > 0);

  if (cloud.roots.length === 0) {
    for (const [root, sortOrder] of withKeys(roots)) {
      await enqueueSubtree(ctx, root, BROWSER_ROOT_ID, sortOrder);
    }
    await ctx.stores.meta.set(META.initialized, true);
    return true;
  }

  if (!localHasContent) {
    await ctx.stores.meta.set(META.cursor, 0);
    await ctx.stores.meta.set(META.initialized, true);
    return true;
  }

  await ctx.stores.meta.set(
    META.lastError,
    'Both this browser and the cloud already contain bookmarks. Merging arrives in Phase 4 — start with one side empty.',
  );
  return false;
}

/**
 * Enqueues creates for any syncable browser root the cloud doesn't know yet
 * (e.g. the cloud tree came from a browser without a Mobile bookmarks root).
 * Runs after every caught-up pull; a fully-mapped tree makes it a no-op.
 */
export async function reconcileRoots(ctx: EngineEnv): Promise<void> {
  const roots = syncableRoots(await ctx.bookmarks.getTree());
  let lastKey: string | null = null;
  const unmapped: BookmarkNodeLite[] = [];
  for (const root of roots) {
    const mapping = await ctx.stores.mappings.get(root.id);
    if (mapping) {
      if (lastKey === null || mapping.sortOrder > lastKey) lastKey = mapping.sortOrder;
    } else {
      unmapped.push(root);
    }
  }
  for (const root of unmapped) {
    lastKey = keyBetween(lastKey, null);
    await enqueueSubtree(ctx, root, BROWSER_ROOT_ID, lastKey);
  }
}

/** Parents before children, so upload order equals queue order. */
async function enqueueSubtree(
  ctx: EngineEnv,
  node: BookmarkNodeLite,
  parentBrowserId: string,
  sortOrder: string,
): Promise<void> {
  await ctx.stores.mappings.put({ browserId: node.id, parentBrowserId, sortOrder });
  await ctx.stores.queue.enqueue({
    opId: ctx.newId(),
    timestamp: ctx.now(),
    kind: 'create',
    browserId: node.id,
    parentBrowserId,
    nodeType: node.url === undefined ? 'folder' : 'bookmark',
    title: node.title,
    ...(node.url !== undefined ? { url: node.url } : {}),
    sortOrder,
  });
  for (const [child, childOrder] of withKeys(node.children ?? [])) {
    await enqueueSubtree(ctx, child, node.id, childOrder);
  }
}

function withKeys(nodes: BookmarkNodeLite[]): Array<[BookmarkNodeLite, string]> {
  let key: string | null = null;
  return nodes.map((node) => {
    key = keyBetween(key, null);
    return [node, key];
  });
}
