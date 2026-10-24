import type { BookmarkNode, SyncOp } from '@nodefav/shared';
import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import {
  BROWSER_ROOT_ID,
  META,
  getDeviceId,
  isInitialized,
  syncableRootTitle,
  syncableRoots,
} from './context.js';
import type { EngineEnv } from './context.js';
import { keyBetween } from './order.js';

/** How to combine a non-empty browser with a non-empty cloud, chosen by the user. */
export type InitialChoice = 'keep-local' | 'keep-cloud' | 'merge';

export const CHOICE_REQUIRED_MESSAGE =
  'Both this browser and the cloud already contain bookmarks. ' +
  'Choose how to combine them in the extension options.';

/**
 * One-time setup, deciding between the three starting states:
 * - empty cloud → walk the native tree and enqueue it (initial upload);
 * - non-empty cloud + fresh profile → replay the op log from version 0
 *   (the pull path materializes the tree and builds the mappings);
 * - both non-empty → wait for the user's keep-local / keep-cloud / merge
 *   choice from the options page (applyInitialChoice).
 * Returns false while initialization is impossible (unconfigured or waiting).
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
    await markInitialized(ctx);
    return true;
  }

  if (!localHasContent) {
    await ctx.stores.meta.set(META.cursor, 0);
    await markInitialized(ctx);
    return true;
  }

  await ctx.stores.meta.set(META.pendingChoice, true);
  await ctx.stores.meta.set(META.lastError, CHOICE_REQUIRED_MESSAGE);
  return false;
}

/**
 * Resolves the both-sides-non-empty state. Capture handlers ignore events
 * until `initialized` is set, so this may freely mutate the native tree
 * without echo bookkeeping. Cloud roots always pair with permanent browser
 * roots (which are immovable and undeletable on every device) — all three
 * choices therefore operate on root *children*, never on roots.
 */
export async function applyInitialChoice(ctx: EngineEnv, choice: InitialChoice): Promise<void> {
  if (await isInitialized(ctx)) return;
  const api = await ctx.getApi();
  if (!api) throw new Error('extension is not configured');

  const cloud = await api.getBookmarks();
  const tree = await ctx.bookmarks.getTree();
  const roots = syncableRoots(tree);
  const { pairs, unpairedCloud } = pairRoots(
    roots,
    cloud.roots.filter((root) => syncableRootTitle(tree, root.title)),
  );

  switch (choice) {
    case 'keep-local': {
      // Soft-delete all cloud content, then upload the local tree in its place.
      // The cursor starts past the deletes: everything before them is history
      // this profile must not replay.
      const deviceId = await getDeviceId(ctx);
      const doomed = [...pairs.flatMap((pair) => pair.cloud.children ?? []), ...unpairedCloud];
      const ops: SyncOp[] = doomed.map((node) => ({
        opId: ctx.newId(),
        deviceId,
        timestamp: ctx.now(),
        type: 'delete',
        uuid: node.uuid,
      }));
      let serverVersion = cloud.serverVersion;
      if (ops.length > 0) serverVersion = (await api.postOps(ops)).serverVersion;

      for (const { root, cloud: cloudRoot } of pairs) {
        await mapNode(ctx, root.id, cloudRoot, BROWSER_ROOT_ID);
        for (const [child, sortOrder] of withKeys(root.children ?? [])) {
          await enqueueSubtree(ctx, child, root.id, sortOrder);
        }
      }
      // Unpaired local roots are reconcileRoots' normal job after the pull.
      await ctx.stores.meta.set(META.cursor, serverVersion);
      break;
    }

    case 'keep-cloud': {
      for (const root of roots) {
        for (const child of root.children ?? []) {
          await ctx.bookmarks.removeTree(child.id);
        }
      }
      await ctx.stores.meta.set(META.cursor, 0);
      break;
    }

    case 'merge': {
      for (const { root, cloud: cloudRoot } of pairs) {
        await mapNode(ctx, root.id, cloudRoot, BROWSER_ROOT_ID);
        await mergeFolder(ctx, root.id, cloudRoot.children ?? []);
      }
      await ctx.stores.meta.set(META.cursor, 0);
      break;
    }
  }

  await markInitialized(ctx);
}

async function markInitialized(ctx: EngineEnv): Promise<void> {
  await ctx.stores.meta.set(META.initialized, true);
  await ctx.stores.meta.remove(META.pendingChoice);
  await ctx.stores.meta.remove(META.lastError);
}

async function mapNode(
  ctx: EngineEnv,
  browserId: string,
  cloudNode: BookmarkNode,
  parentBrowserId: string,
): Promise<void> {
  await ctx.stores.mappings.put({
    browserId,
    uuid: cloudNode.uuid,
    parentBrowserId,
    sortOrder: cloudNode.sortOrder,
  });
}

/**
 * Pairs syncable browser roots with root-level cloud folders: normalized-title
 * matches first, then a single positional match for the first root's localized
 * title (mirrors adoptCloudRoot in the puller).
 */
function pairRoots(
  roots: BookmarkNodeLite[],
  cloudRoots: BookmarkNode[],
): {
  pairs: Array<{ root: BookmarkNodeLite; cloud: BookmarkNode }>;
  unpairedCloud: BookmarkNode[];
} {
  const remainingCloud = cloudRoots.filter((node) => node.type === 'folder');
  const nonFolders = cloudRoots.filter((node) => node.type !== 'folder');
  const pairs: Array<{ root: BookmarkNodeLite; cloud: BookmarkNode }> = [];
  let firstUnmatched: BookmarkNodeLite | undefined;

  for (const root of roots) {
    const index = remainingCloud.findIndex(
      (cloud) => normalize(cloud.title) === normalize(root.title),
    );
    if (index === -1) {
      if (root === roots[0]) firstUnmatched = root;
    } else {
      pairs.push({ root, cloud: remainingCloud[index] as BookmarkNode });
      remainingCloud.splice(index, 1);
    }
  }
  if (firstUnmatched) {
    const cloud = remainingCloud.shift();
    if (cloud) pairs.push({ root: firstUnmatched, cloud });
  }
  return { pairs, unpairedCloud: [...remainingCloud, ...nonFolders] };
}

/**
 * Merges one paired folder. Local children matching a cloud child (folders by
 * title, bookmarks by url + title) adopt its uuid instead of re-uploading;
 * matched nodes are natively reordered into cloud order; local-only children
 * get keys after every cloud key and are enqueued as creates. Cloud-only
 * children need nothing here — the log replay materializes them.
 */
async function mergeFolder(
  ctx: EngineEnv,
  browserId: string,
  cloudChildren: BookmarkNode[],
): Promise<void> {
  const available = new Map<string, BookmarkNode[]>();
  for (const cloud of cloudChildren) {
    const key = cloudMatchKey(cloud);
    available.set(key, [...(available.get(key) ?? []), cloud]);
  }

  const matched: Array<{ local: BookmarkNodeLite; cloud: BookmarkNode }> = [];
  const localOnly: BookmarkNodeLite[] = [];
  for (const local of await ctx.bookmarks.getChildren(browserId)) {
    const cloud = available.get(localMatchKey(local))?.shift();
    if (cloud) matched.push({ local, cloud });
    else localOnly.push(local);
  }

  for (const { local, cloud } of matched) {
    await mapNode(ctx, local.id, cloud, browserId);
    if (local.url === undefined) {
      await mergeFolder(ctx, local.id, cloud.children ?? []);
    }
  }

  // Native reorder into cloud (sortOrder, uuid) order: slot i for the i-th
  // matched node; unmatched children drift right, ending up after the matched
  // block — consistent with their appended keys.
  const inCloudOrder = [...matched].sort((a, b) =>
    a.cloud.sortOrder < b.cloud.sortOrder
      ? -1
      : a.cloud.sortOrder > b.cloud.sortOrder
        ? 1
        : a.cloud.uuid < b.cloud.uuid
          ? -1
          : 1,
  );
  for (const [slot, { local }] of inCloudOrder.entries()) {
    const current = (await ctx.bookmarks.getChildren(browserId)).findIndex(
      (node) => node.id === local.id,
    );
    if (current !== slot) {
      await ctx.bookmarks.move(local.id, { parentId: browserId, index: slot });
    }
  }

  let key: string | null = null;
  for (const cloud of cloudChildren) {
    if (key === null || cloud.sortOrder > key) key = cloud.sortOrder;
  }
  for (const local of localOnly) {
    key = keyBetween(key, null);
    await enqueueSubtree(ctx, local, browserId, key);
  }
}

function normalize(title: string): string {
  return title.trim().toLowerCase();
}

function localMatchKey(node: BookmarkNodeLite): string {
  return node.url === undefined
    ? `f:${normalize(node.title)}`
    : `b:${node.url}\n${normalize(node.title)}`;
}

function cloudMatchKey(node: BookmarkNode): string {
  return node.type === 'folder'
    ? `f:${normalize(node.title)}`
    : `b:${node.url ?? ''}\n${normalize(node.title)}`;
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
export async function enqueueSubtree(
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
