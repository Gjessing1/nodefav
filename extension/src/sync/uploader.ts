import type { OpResult, SyncOp } from '@nodefav/shared';
import { BROWSER_ROOT_ID, getDeviceId, isInitialized } from './context.js';
import type { EngineEnv } from './context.js';
import type { QueuedOp } from './types.js';

const MAX_BATCH = 200;

/**
 * Drains the durable queue in order. Queue items reference nodes by browser id;
 * resolution to cloud uuids happens here. An op that depends on a create
 * *earlier in the same batch* (the server hasn't assigned that uuid yet) cuts
 * the batch — the remainder uploads on the next round, after the create's
 * result has filled the mapping. Ops that can never resolve (unsynced subtrees)
 * are dropped. Throws on network failure; the queue is untouched and idempotent
 * to retry.
 */
export async function flush(ctx: EngineEnv): Promise<void> {
  if (!(await isInitialized(ctx))) return;
  const api = await ctx.getApi();
  if (!api) return;
  const deviceId = await getDeviceId(ctx);

  for (;;) {
    const items = await ctx.stores.queue.peek(MAX_BATCH);
    if (items.length === 0) return;

    const { batch, droppedQids } = await resolveBatch(ctx, deviceId, items);
    if (droppedQids.length > 0) await ctx.stores.queue.remove(droppedQids);
    if (batch.length === 0) {
      if (droppedQids.length === 0) return; // defensive — nothing can progress
      continue;
    }

    const response = await api.postOps(batch.map((entry) => entry.op));
    await applyResults(ctx, batch, response.results);
    await ctx.stores.queue.remove(batch.map((entry) => entry.qid));
  }
}

interface BatchEntry {
  qid: number;
  browserId: string;
  op: SyncOp;
}

type Resolution = { ok: SyncOp } | 'defer' | 'drop';

async function resolveBatch(
  ctx: EngineEnv,
  deviceId: string,
  items: QueuedOp[],
): Promise<{ batch: BatchEntry[]; droppedQids: number[] }> {
  const batch: BatchEntry[] = [];
  const droppedQids: number[] = [];
  const pendingCreates = new Set<string>();

  for (const item of items) {
    const resolution = await resolveItem(ctx, deviceId, item, pendingCreates);
    if (resolution === 'defer') break;
    if (resolution === 'drop') {
      ctx.log(`dropping unresolvable ${item.kind} op for browser id ${item.browserId}`);
      droppedQids.push(item.qid);
      continue;
    }
    batch.push({ qid: item.qid, browserId: item.browserId, op: resolution.ok });
    if (item.kind === 'create') pendingCreates.add(item.browserId);
  }
  return { batch, droppedQids };
}

async function resolveItem(
  ctx: EngineEnv,
  deviceId: string,
  item: QueuedOp,
  pendingCreates: Set<string>,
): Promise<Resolution> {
  const base = { opId: item.opId, deviceId, timestamp: item.timestamp };

  switch (item.kind) {
    case 'create': {
      if (!item.nodeType || !item.sortOrder || item.parentBrowserId === undefined) return 'drop';
      const parent = await resolveNode(ctx, item.parentBrowserId, pendingCreates, true);
      if (parent === 'defer' || parent === 'drop') return parent;
      return {
        ok: {
          ...base,
          type: 'create',
          parentUuid: parent.uuid,
          nodeType: item.nodeType,
          title: item.title ?? '',
          ...(item.nodeType === 'bookmark' ? { url: item.url ?? '' } : {}),
          sortOrder: item.sortOrder,
        },
      };
    }
    case 'update': {
      if (item.title === undefined && item.url === undefined) return 'drop';
      const target = await resolveNode(ctx, item.browserId, pendingCreates, false);
      if (target === 'defer' || target === 'drop') return target;
      if (target.uuid === null) return 'drop';
      return {
        ok: {
          ...base,
          type: 'update',
          uuid: target.uuid,
          ...(item.title !== undefined ? { title: item.title } : {}),
          ...(item.url !== undefined ? { url: item.url } : {}),
        },
      };
    }
    case 'move': {
      if (!item.sortOrder || item.parentBrowserId === undefined) return 'drop';
      const target = await resolveNode(ctx, item.browserId, pendingCreates, false);
      if (target === 'defer' || target === 'drop') return target;
      if (target.uuid === null) return 'drop';
      const parent = await resolveNode(ctx, item.parentBrowserId, pendingCreates, true);
      if (parent === 'defer' || parent === 'drop') return parent;
      return {
        ok: {
          ...base,
          type: 'move',
          uuid: target.uuid,
          parentUuid: parent.uuid,
          sortOrder: item.sortOrder,
        },
      };
    }
    case 'delete': {
      const target = await resolveNode(ctx, item.browserId, pendingCreates, false);
      if (target === 'defer' || target === 'drop') return target;
      if (target.uuid === null) return 'drop';
      return { ok: { ...base, type: 'delete', uuid: target.uuid } };
    }
  }
}

/**
 * browserId → uuid. `allowRoot` maps the browser root to the cloud root
 * (parentUuid null). 'defer' when the uuid will exist after the current batch
 * uploads; 'drop' when it never will.
 */
async function resolveNode(
  ctx: EngineEnv,
  browserId: string,
  pendingCreates: Set<string>,
  allowRoot: boolean,
): Promise<{ uuid: string | null } | 'defer' | 'drop'> {
  if (allowRoot && browserId === BROWSER_ROOT_ID) return { uuid: null };
  const mapping = await ctx.stores.mappings.get(browserId);
  if (mapping?.uuid) return { uuid: mapping.uuid };
  if (pendingCreates.has(browserId)) return 'defer';
  return 'drop';
}

async function applyResults(
  ctx: EngineEnv,
  batch: BatchEntry[],
  results: OpResult[],
): Promise<void> {
  const byOpId = new Map(results.map((result) => [result.opId, result]));
  for (const entry of batch) {
    const result = byOpId.get(entry.op.opId);
    if (!result) {
      ctx.log(`server returned no result for op ${entry.op.opId}`);
      continue;
    }
    if (result.status === 'rejected') {
      ctx.log(`server rejected ${entry.op.type} op: ${result.error ?? 'unknown reason'}`);
    }
    if (
      entry.op.type === 'create' &&
      result.uuid &&
      (result.status === 'applied' || result.status === 'duplicate')
    ) {
      await ctx.stores.mappings.setUuid(entry.browserId, result.uuid);
    }
    if (entry.op.type === 'delete') {
      // The node is gone locally regardless of the server's verdict.
      await ctx.stores.mappings.removeSubtree(entry.browserId);
    }
  }
}
