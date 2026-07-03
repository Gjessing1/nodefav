import { checksumEntriesFromTree, treeChecksum } from '@nodefav/shared';
import type { BookmarkNode, ChecksumEntry, RemoteOp } from '@nodefav/shared';
import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { META, isInitialized, syncableRoots } from './context.js';
import type { EngineEnv } from './context.js';
import { enqueueSubtree } from './initial.js';
import { keyBetween } from './order.js';
import { applyRemoteOp } from './puller.js';

/**
 * Drift-detection backstop (Phase 5). Event-driven sync is primary; this pass
 * runs rarely, compares a checksum of the locally-synced state against the
 * cloud's, and repairs what it finds. Two drift directions:
 * - local nodes the cloud never learned about (missed capture events) are
 *   re-uploaded as ordinary queued creates;
 * - everything else is repaired cloud-wins, by synthesizing the remote ops the
 *   puller would have applied (so echo suppression and mapping bookkeeping
 *   behave exactly like a normal pull).
 * Only runs when fully caught up (empty queue, cursor at server version) —
 * anything in flight makes a mismatch expected rather than drift.
 */
export type ReconcileOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'clean' }
  | { status: 'uploads-queued'; queued: number }
  | { status: 'repaired'; repaired: number; residualDrift: boolean };

export async function reconcile(ctx: EngineEnv): Promise<ReconcileOutcome> {
  if (!(await isInitialized(ctx))) return { status: 'skipped', reason: 'not initialized' };
  const api = await ctx.getApi();
  if (!api) return { status: 'skipped', reason: 'not configured' };
  if ((await ctx.stores.queue.size()) > 0) return { status: 'skipped', reason: 'queue not empty' };

  const remote = await api.getChecksum();
  const cursor = (await ctx.stores.meta.get<number>(META.cursor)) ?? 0;
  if (remote.serverVersion !== cursor) return { status: 'skipped', reason: 'not caught up' };

  const queued = await enqueueUnsynced(ctx);
  if (queued > 0) return { status: 'uploads-queued', queued };

  if (treeChecksum(await localEntries(ctx, new Set(remote.rootUuids))) === remote.checksum) {
    return { status: 'clean' };
  }

  const { roots } = await api.getBookmarks();
  const repaired = await repair(ctx, roots);

  const localAfter = await localEntries(ctx, new Set(roots.map((root) => root.uuid)));
  const residualDrift = treeChecksum(localAfter) !== treeChecksum(checksumEntriesFromTree(roots));
  return { status: 'repaired', repaired, residualDrift };
}

/**
 * The local counterpart of GET /api/checksum: entries for every synced native
 * node below root level, from the native tree + the mapping shadow. Unsynced
 * subtrees (no uuid yet) are excluded on both sides — enqueueUnsynced owns
 * those — and so are root-level nodes (browser-localized titles, immovable).
 */
async function localEntries(ctx: EngineEnv, rootUuids: Set<string>): Promise<ChecksumEntry[]> {
  const entries: ChecksumEntry[] = [];
  const walk = async (node: BookmarkNodeLite, parentUuid: string | null): Promise<void> => {
    const mapping = await ctx.stores.mappings.get(node.id);
    const uuid = mapping?.uuid;
    if (mapping === undefined || uuid === undefined) return;
    if (parentUuid !== null && !rootUuids.has(uuid)) {
      entries.push({
        uuid,
        parentUuid,
        type: node.url === undefined ? 'folder' : 'bookmark',
        title: node.title,
        url: node.url ?? null,
        sortOrder: mapping.sortOrder,
      });
    }
    for (const child of node.children ?? []) await walk(child, uuid);
  };
  for (const root of syncableRoots(await ctx.bookmarks.getTree())) await walk(root, null);
  return entries;
}

/**
 * Re-uploads native subtrees the cloud never learned about: children of synced
 * folders that have no uuid (missed create events, or creates the uploader had
 * to drop). Keys append after the highest synced sibling. Returns the number
 * of subtree roots enqueued.
 */
async function enqueueUnsynced(ctx: EngineEnv): Promise<number> {
  let queued = 0;
  const walkFolder = async (folder: BookmarkNodeLite): Promise<void> => {
    let maxKey: string | null = null;
    const unsynced: BookmarkNodeLite[] = [];
    const syncedFolders: BookmarkNodeLite[] = [];
    for (const child of folder.children ?? []) {
      const mapping = await ctx.stores.mappings.get(child.id);
      if (mapping?.uuid !== undefined) {
        if (maxKey === null || mapping.sortOrder > maxKey) maxKey = mapping.sortOrder;
        if (child.url === undefined) syncedFolders.push(child);
      } else {
        unsynced.push(child);
      }
    }
    for (const child of unsynced) {
      maxKey = keyBetween(maxKey, null);
      ctx.log(`reconcile: re-uploading unsynced subtree at ${child.id} ("${child.title}")`);
      await enqueueSubtree(ctx, child, folder.id, maxKey);
      queued += 1;
    }
    for (const child of syncedFolders) await walkFolder(child);
  };
  for (const root of syncableRoots(await ctx.bookmarks.getTree())) {
    if ((await ctx.stores.mappings.get(root.id))?.uuid !== undefined) await walkFolder(root);
  }
  return queued;
}

/**
 * Cloud-wins repair: walks the served tree parents-first, synthesizes the
 * remote ops whose effects are missing locally, and applies them through the
 * puller machinery. Root-level nodes only ever get materialized/adopted —
 * their title and position are browser-owned. Applied as creates, then moves
 * (so nothing is trapped inside a doomed folder), then updates, then deletes.
 */
async function repair(ctx: EngineEnv, roots: BookmarkNode[]): Promise<number> {
  const creates: RemoteOp[] = [];
  const moves: RemoteOp[] = [];
  const updates: RemoteOp[] = [];
  const deletes: RemoteOp[] = [];
  const cloudLive = new Set<string>();
  const synth = (fields: object): RemoteOp =>
    ({
      opId: `reconcile-${ctx.newId()}`,
      deviceId: 'local:reconcile',
      timestamp: ctx.now(),
      seq: 0,
      ...fields,
    }) as RemoteOp;

  const visit = async (node: BookmarkNode): Promise<void> => {
    cloudLive.add(node.uuid);
    const mapping = await ctx.stores.mappings.getByUuid(node.uuid);
    const native = mapping ? await ctx.bookmarks.get(mapping.browserId) : undefined;

    if (!mapping || !native) {
      // A mapping whose native node vanished (missed removal event) is stale
      // for the whole native subtree — clear it so the create can materialize.
      if (mapping && !native) await ctx.stores.mappings.removeSubtree(mapping.browserId);
      creates.push(
        synth({
          type: 'create',
          uuid: node.uuid,
          parentUuid: node.parentUuid,
          nodeType: node.type,
          title: node.title,
          ...(node.type === 'bookmark' ? { url: node.url ?? '' } : {}),
          sortOrder: node.sortOrder,
        }),
      );
    } else if (node.parentUuid !== null) {
      const wantUrl = node.type === 'bookmark' ? (node.url ?? '') : undefined;
      if (
        node.title !== native.title ||
        (wantUrl !== undefined && wantUrl !== (native.url ?? ''))
      ) {
        updates.push(
          synth({
            type: 'update',
            uuid: node.uuid,
            title: node.title,
            ...(wantUrl !== undefined ? { url: wantUrl } : {}),
          }),
        );
      }
      const parentMapping =
        native.parentId !== undefined ? await ctx.stores.mappings.get(native.parentId) : undefined;
      if (
        (parentMapping?.uuid ?? null) !== node.parentUuid ||
        mapping.sortOrder !== node.sortOrder
      ) {
        // Refresh the shadow to native truth first — a stale shadow that already
        // claims the target position would make applyMove skip the repair.
        if (native.parentId !== undefined && mapping.parentBrowserId !== native.parentId) {
          await ctx.stores.mappings.put({ ...mapping, parentBrowserId: native.parentId });
        }
        moves.push(
          synth({
            type: 'move',
            uuid: node.uuid,
            parentUuid: node.parentUuid,
            sortOrder: node.sortOrder,
          }),
        );
      }
    }
    for (const child of node.children ?? []) await visit(child);
  };
  for (const root of roots) await visit(root);

  for (const mapping of await ctx.stores.mappings.all()) {
    if (mapping.uuid !== undefined && !cloudLive.has(mapping.uuid)) {
      deletes.push(synth({ type: 'delete', uuid: mapping.uuid }));
    }
  }

  const ops = [...creates, ...moves, ...updates, ...deletes];
  for (const op of ops) {
    ctx.log(`reconcile: repairing via ${op.type} for ${op.uuid}`);
    await applyRemoteOp(ctx, op);
  }
  return ops.length;
}
