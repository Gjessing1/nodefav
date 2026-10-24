import type { BookmarkNodeLite, ChangeInfo, MoveInfo, RemoveInfo } from '../chrome/bookmarksApi.js';
import { BROWSER_ROOT_ID, isInitialized, isSyncableLocation } from './context.js';
import { enqueueSubtree } from './initial.js';
import type { EngineEnv } from './context.js';
import { MAX_KEY_LENGTH, keyBetween, spreadKeys } from './order.js';
import type { Mapping } from './types.js';

/**
 * Translates native bookmark events into queued sync ops. Two things never
 * reach the queue: echoes of remote-applied changes (matched against the
 * persisted echo registry — Phase 3's loop prevention) and events in unsynced
 * subtrees (no mapping, e.g. policy-managed bookmarks).
 */

export async function handleCreated(
  ctx: EngineEnv,
  id: string,
  node: BookmarkNodeLite,
): Promise<void> {
  if (!(await isInitialized(ctx))) return;

  const echo = await ctx.stores.echoes.consume({
    action: 'create',
    browserId: id,
    parentBrowserId: node.parentId,
    title: node.title,
    url: node.url,
  });
  if (echo) {
    await ctx.stores.mappings.put({
      browserId: id,
      uuid: echo.uuid,
      parentBrowserId: node.parentId ?? BROWSER_ROOT_ID,
      sortOrder: echo.sortOrder ?? keyBetween(null, null),
    });
    return;
  }

  const parentId = node.parentId;
  if (!parentId || node.unmodifiable) return;
  if (!(await isSyncableLocation(ctx, parentId))) return;
  if (parentId !== BROWSER_ROOT_ID && !(await ctx.stores.mappings.get(parentId))) return;

  const sortOrder = await sortOrderAt(ctx, parentId, id, node.index);
  await ctx.stores.mappings.put({ browserId: id, parentBrowserId: parentId, sortOrder });
  await ctx.stores.queue.enqueue({
    opId: ctx.newId(),
    timestamp: ctx.now(),
    kind: 'create',
    browserId: id,
    parentBrowserId: parentId,
    nodeType: node.url === undefined ? 'folder' : 'bookmark',
    title: node.title,
    ...(node.url !== undefined ? { url: node.url } : {}),
    sortOrder,
  });
}

export async function handleChanged(
  ctx: EngineEnv,
  id: string,
  changeInfo: ChangeInfo,
): Promise<void> {
  if (!(await isInitialized(ctx))) return;

  const echo = await ctx.stores.echoes.consume({
    action: 'update',
    browserId: id,
    title: changeInfo.title,
    url: changeInfo.url,
  });
  if (echo) return;

  if (!(await ctx.stores.mappings.get(id)) || !(await isSyncableLocation(ctx, id))) return;
  await ctx.stores.queue.enqueue({
    opId: ctx.newId(),
    timestamp: ctx.now(),
    kind: 'update',
    browserId: id,
    title: changeInfo.title,
    ...(changeInfo.url !== undefined ? { url: changeInfo.url } : {}),
  });
}

export async function handleMoved(ctx: EngineEnv, id: string, moveInfo: MoveInfo): Promise<void> {
  if (!(await isInitialized(ctx))) return;

  const echo = await ctx.stores.echoes.consume({
    action: 'move',
    browserId: id,
    parentBrowserId: moveInfo.parentId,
  });
  const mapping = await ctx.stores.mappings.get(id);
  if (echo) {
    // Repair the local shadow even when the puller died before recording it.
    if (mapping) {
      await ctx.stores.mappings.put({
        ...mapping,
        parentBrowserId: moveInfo.parentId,
        sortOrder: echo.sortOrder ?? mapping.sortOrder,
      });
    }
    return;
  }

  const destinationSyncable = await isSyncableLocation(ctx, moveInfo.parentId);
  if (!destinationSyncable) {
    if (mapping?.uuid) {
      await ctx.stores.queue.enqueue({
        opId: ctx.newId(),
        timestamp: ctx.now(),
        kind: 'delete',
        browserId: id,
      });
    }
    return;
  }
  if (!mapping) {
    const tree = await ctx.bookmarks.getTree();
    const find = (nodes: BookmarkNodeLite[]): BookmarkNodeLite | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const child = find(node.children ?? []);
        if (child) return child;
      }
      return undefined;
    };
    const node = find(tree);
    if (node) {
      const sortOrder = await sortOrderAt(ctx, moveInfo.parentId, id, moveInfo.index);
      await enqueueSubtree(ctx, node, moveInfo.parentId, sortOrder);
    }
    return;
  }
  const sortOrder = await sortOrderAt(ctx, moveInfo.parentId, id, moveInfo.index);
  await ctx.stores.mappings.put({ ...mapping, parentBrowserId: moveInfo.parentId, sortOrder });
  await ctx.stores.queue.enqueue({
    opId: ctx.newId(),
    timestamp: ctx.now(),
    kind: 'move',
    browserId: id,
    parentBrowserId: moveInfo.parentId,
    sortOrder,
  });
}

export async function handleRemoved(
  ctx: EngineEnv,
  id: string,
  removeInfo: RemoveInfo,
): Promise<void> {
  if (!(await isInitialized(ctx))) return;

  const echo = await ctx.stores.echoes.consume({ action: 'delete', browserId: id });
  if (echo) {
    await ctx.stores.mappings.removeSubtree(id);
    return;
  }

  if (!(await ctx.stores.mappings.get(id))) return;
  if (!(await isSyncableLocation(ctx, removeInfo.parentId))) return;
  // Mapping removal is deferred to the uploader: earlier queued ops touching
  // descendants still need the mappings to resolve their uuids.
  await ctx.stores.queue.enqueue({
    opId: ctx.newId(),
    timestamp: ctx.now(),
    kind: 'delete',
    browserId: id,
  });
}

/**
 * Fractional key for the node at its current position: between the nearest
 * mapped siblings. The local shadow can be momentarily inconsistent during
 * bursts, so an inverted interval falls back to appending. When repeated
 * insertion into the same gap has exhausted key precision, every mapped
 * sibling gets a fresh evenly-spread key (as queued move ops) first.
 */
async function sortOrderAt(
  ctx: EngineEnv,
  parentId: string,
  selfId: string,
  index: number | undefined,
): Promise<string> {
  const siblings = await ctx.bookmarks.getChildren(parentId);
  let pos = index !== undefined && siblings[index]?.id === selfId ? index : -1;
  if (pos === -1) pos = siblings.findIndex((s) => s.id === selfId);
  if (pos === -1) pos = siblings.length;

  const key = await keyAt(ctx, siblings, pos, selfId);
  if (key.length <= MAX_KEY_LENGTH) return key;

  await rebalanceSiblings(ctx, parentId, selfId, siblings);
  return keyAt(ctx, siblings, pos, selfId);
}

/** Key between the nearest mapped siblings around `pos` (fresh mapping reads). */
async function keyAt(
  ctx: EngineEnv,
  siblings: BookmarkNodeLite[],
  pos: number,
  selfId: string,
): Promise<string> {
  let before: string | null = null;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const sibling = siblings[i];
    const m = sibling && (await ctx.stores.mappings.get(sibling.id));
    if (m) {
      before = m.sortOrder;
      break;
    }
  }
  let after: string | null = null;
  for (let i = pos + 1; i < siblings.length; i += 1) {
    const sibling = siblings[i];
    if (!sibling || sibling.id === selfId) continue;
    const m = await ctx.stores.mappings.get(sibling.id);
    if (m) {
      after = m.sortOrder;
      break;
    }
  }

  try {
    return keyBetween(before, after);
  } catch {
    try {
      return keyBetween(before, null);
    } catch {
      return keyBetween(null, null);
    }
  }
}

/**
 * Precision-exhaustion rebalance: reassigns short evenly-spread keys to every
 * mapped sibling (excluding the node being placed), in current native order.
 * Each reassignment updates the local shadow and queues a same-parent move op,
 * so other devices converge on the fresh keys too.
 */
async function rebalanceSiblings(
  ctx: EngineEnv,
  parentId: string,
  selfId: string,
  siblings: BookmarkNodeLite[],
): Promise<void> {
  const mapped: Array<{ id: string; mapping: Mapping }> = [];
  for (const sibling of siblings) {
    if (sibling.id === selfId) continue;
    const mapping = await ctx.stores.mappings.get(sibling.id);
    if (mapping) mapped.push({ id: sibling.id, mapping });
  }
  const keys = spreadKeys(mapped.length);
  ctx.log(`rebalancing ${mapped.length} sort keys under parent ${parentId}`);
  for (const [i, { id, mapping }] of mapped.entries()) {
    const sortOrder = keys[i] as string;
    if (mapping.sortOrder === sortOrder) continue;
    await ctx.stores.mappings.put({ ...mapping, sortOrder });
    await ctx.stores.queue.enqueue({
      opId: ctx.newId(),
      timestamp: ctx.now(),
      kind: 'move',
      browserId: id,
      parentBrowserId: parentId,
      sortOrder,
    });
  }
}
