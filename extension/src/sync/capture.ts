import type { BookmarkNodeLite, ChangeInfo, MoveInfo, RemoveInfo } from '../chrome/bookmarksApi.js';
import { BROWSER_ROOT_ID, isInitialized } from './context.js';
import type { EngineEnv } from './context.js';
import { keyBetween } from './order.js';

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

  if (!(await ctx.stores.mappings.get(id))) return;
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

  if (!mapping) return;
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
  _removeInfo: RemoveInfo,
): Promise<void> {
  if (!(await isInitialized(ctx))) return;

  const echo = await ctx.stores.echoes.consume({ action: 'delete', browserId: id });
  if (echo) {
    await ctx.stores.mappings.removeSubtree(id);
    return;
  }

  if (!(await ctx.stores.mappings.get(id))) return;
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
 * bursts, so an inverted interval falls back to appending — exact convergent
 * ordering is Phase 4's problem.
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
