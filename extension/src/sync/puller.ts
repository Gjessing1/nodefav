import type { RemoteOp } from '@nodefav/shared';
import type { BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import {
  BROWSER_ROOT_ID,
  META,
  isInitialized,
  syncableRootTitle,
  syncableRoots,
} from './context.js';
import type { EngineEnv } from './context.js';

const PULL_LIMIT = 500;

/**
 * Pulls operations past the persisted cursor and applies them to the native
 * tree. The cursor advances after every op, so a service-worker death
 * mid-batch resumes exactly where it stopped; every apply step is idempotent
 * to retry. Own-device ops are NOT skipped: the server's log applied in seq
 * order always lands on the server's LWW-resolved state, and truncating our
 * own ops out of the replay would strand us on a concurrent older remote op.
 * Re-applying an own op is a no-op (idempotence). Loop prevention is the
 * *persisted* echo record written before every native mutation, which the
 * capture handlers consume instead of re-uploading the event. Returns true
 * once caught up with the server.
 */
export async function pull(ctx: EngineEnv): Promise<boolean> {
  if (!(await isInitialized(ctx))) return false;
  const api = await ctx.getApi();
  if (!api) return false;
  const tree = await ctx.bookmarks.getTree();
  const { roots } = await api.getBookmarks();
  const excludedUuids = new Set<string>();
  const exclude = (node: (typeof roots)[number]): void => {
    excludedUuids.add(node.uuid);
    for (const child of node.children ?? []) exclude(child);
  };
  for (const root of roots) {
    if (!syncableRootTitle(tree, root.title)) exclude(root);
  }

  for (;;) {
    const cursor = (await ctx.stores.meta.get<number>(META.cursor)) ?? 0;
    const { ops } = await api.getOps(cursor, PULL_LIMIT);
    for (const op of ops) {
      if (
        !excludedUuids.has(op.uuid) &&
        !(
          (op.type === 'create' || op.type === 'move') &&
          op.parentUuid &&
          excludedUuids.has(op.parentUuid)
        )
      ) {
        await applyRemoteOp(ctx, op);
      }
      await ctx.stores.meta.set(META.cursor, op.seq);
    }
    if (ops.length < PULL_LIMIT) return true;
  }
}

/** Applies one already-logged (or synthesized — reconciliation) op natively. */
export async function applyRemoteOp(ctx: EngineEnv, op: RemoteOp): Promise<void> {
  switch (op.type) {
    case 'create':
      return applyCreate(ctx, op);
    case 'update':
      return applyUpdate(ctx, op);
    case 'move':
      return applyMove(ctx, op);
    case 'delete':
      return applyDelete(ctx, op);
  }
}

async function applyCreate(ctx: EngineEnv, op: RemoteOp & { type: 'create' }): Promise<void> {
  if (op.parentUuid === null && !syncableRootTitle(await ctx.bookmarks.getTree(), op.title)) {
    return;
  }
  if (await ctx.stores.mappings.getByUuid(op.uuid)) return; // already applied

  let parentBrowserId: string;
  if (op.parentUuid === null) {
    if (op.nodeType === 'folder' && (await adoptCloudRoot(ctx, op))) return;
    // More cloud roots than browser roots: materialize as a plain node under a local root.
    parentBrowserId = await fallbackRootId(ctx);
  } else {
    const parent = await ctx.stores.mappings.getByUuid(op.parentUuid);
    if (!parent) {
      ctx.log(
        `skipping remote create ${op.uuid} (seq ${op.seq}): unmapped parent ${op.parentUuid}`,
      );
      return;
    }
    parentBrowserId = parent.browserId;
  }

  const url = op.nodeType === 'bookmark' ? op.url : undefined;

  // Crash retry: a previous attempt may have created the node and died before
  // writing the mapping. Its persisted echo record is the tell — adopt the
  // orphan instead of creating a duplicate. The record itself stays: the echoed
  // event may still be pending delivery (TTL cleans it up otherwise).
  const prior = await ctx.stores.echoes.findByUuid(op.uuid, 'create');
  if (prior) {
    const orphan = await findUnmappedMatch(ctx, parentBrowserId, op.title, url);
    if (orphan) {
      await ctx.stores.mappings.put({
        browserId: orphan.id,
        uuid: op.uuid,
        parentBrowserId,
        sortOrder: op.sortOrder,
      });
      return;
    }
  }

  // Persist the expected echo BEFORE touching the native tree.
  await ctx.stores.echoes.add({
    action: 'create',
    uuid: op.uuid,
    parentBrowserId,
    title: op.title,
    ...(url !== undefined ? { url } : {}),
    sortOrder: op.sortOrder,
  });
  const index = await indexForSortOrder(ctx, parentBrowserId, op.sortOrder, op.uuid, undefined);
  const node = await ctx.bookmarks.create({
    parentId: parentBrowserId,
    index,
    title: op.title,
    ...(url !== undefined ? { url } : {}),
  });
  await ctx.stores.mappings.put({
    browserId: node.id,
    uuid: op.uuid,
    parentBrowserId,
    sortOrder: op.sortOrder,
  });
}

async function applyUpdate(ctx: EngineEnv, op: RemoteOp & { type: 'update' }): Promise<void> {
  const mapping = await ctx.stores.mappings.getByUuid(op.uuid);
  if (!mapping) {
    ctx.log(`skipping remote update for unmapped ${op.uuid} (seq ${op.seq})`);
    return;
  }
  const node = await ctx.bookmarks.get(mapping.browserId);
  if (!node) {
    ctx.log(`skipping remote update ${op.uuid}: node ${mapping.browserId} is gone`);
    return;
  }
  const changes: { title?: string; url?: string } = {
    ...(op.title !== undefined && op.title !== node.title ? { title: op.title } : {}),
    ...(op.url !== undefined && node.url !== undefined && op.url !== node.url
      ? { url: op.url }
      : {}),
  };
  if (changes.title === undefined && changes.url === undefined) return; // already applied

  const echo = await ctx.stores.echoes.add({
    action: 'update',
    uuid: op.uuid,
    browserId: mapping.browserId,
    ...changes,
  });
  const ok = await ctx.bookmarks.update(mapping.browserId, changes);
  if (!ok) await ctx.stores.echoes.remove(echo.id); // no event will ever come
}

async function applyMove(ctx: EngineEnv, op: RemoteOp & { type: 'move' }): Promise<void> {
  const mapping = await ctx.stores.mappings.getByUuid(op.uuid);
  if (!mapping) {
    ctx.log(`skipping remote move for unmapped ${op.uuid} (seq ${op.seq})`);
    return;
  }
  if (op.parentUuid === null) {
    // Browser roots are immovable; nothing can legitimately move to root level.
    ctx.log(`skipping remote move ${op.uuid}: root-level target`);
    return;
  }
  const parent = await ctx.stores.mappings.getByUuid(op.parentUuid);
  if (!parent) {
    ctx.log(`skipping remote move ${op.uuid}: unmapped parent ${op.parentUuid}`);
    return;
  }
  if (mapping.parentBrowserId === parent.browserId && mapping.sortOrder === op.sortOrder) {
    return; // already there (crash retry)
  }

  const index = await indexForSortOrder(
    ctx,
    parent.browserId,
    op.sortOrder,
    op.uuid,
    mapping.browserId,
  );
  const echo = await ctx.stores.echoes.add({
    action: 'move',
    uuid: op.uuid,
    browserId: mapping.browserId,
    parentBrowserId: parent.browserId,
    sortOrder: op.sortOrder,
  });
  const ok = await ctx.bookmarks.move(mapping.browserId, { parentId: parent.browserId, index });
  if (!ok) {
    await ctx.stores.echoes.remove(echo.id);
    return;
  }
  await ctx.stores.mappings.put({
    ...mapping,
    parentBrowserId: parent.browserId,
    sortOrder: op.sortOrder,
  });
}

async function applyDelete(ctx: EngineEnv, op: RemoteOp & { type: 'delete' }): Promise<void> {
  const mapping = await ctx.stores.mappings.getByUuid(op.uuid);
  if (!mapping) return; // never materialized or already gone
  await ctx.stores.echoes.add({ action: 'delete', uuid: op.uuid, browserId: mapping.browserId });
  await ctx.bookmarks.removeTree(mapping.browserId);
  await ctx.stores.mappings.removeSubtree(mapping.browserId);
}

/**
 * A cloud root folder (parentUuid null) pairs with a permanent browser root
 * rather than creating anything: match unmapped roots by normalized title,
 * falling back only for the first root (localized bar titles differ). Further
 * unmatched cloud roots become ordinary folders under the visible first root.
 */
async function adoptCloudRoot(ctx: EngineEnv, op: RemoteOp & { type: 'create' }): Promise<boolean> {
  const roots = syncableRoots(await ctx.bookmarks.getTree());
  const unmapped: BookmarkNodeLite[] = [];
  for (const root of roots) {
    if (!(await ctx.stores.mappings.get(root.id))) unmapped.push(root);
  }
  const normalize = (title: string): string => title.trim().toLowerCase();
  const match =
    unmapped.find((root) => normalize(root.title) === normalize(op.title)) ??
    (unmapped.length === roots.length ? roots[0] : undefined);
  if (!match) return false;
  await ctx.stores.mappings.put({
    browserId: match.id,
    uuid: op.uuid,
    parentBrowserId: BROWSER_ROOT_ID,
    sortOrder: op.sortOrder,
  });
  return true;
}

/** Surplus cloud roots must remain visible rather than landing in a hidden root. */
async function fallbackRootId(ctx: EngineEnv): Promise<string> {
  const roots = syncableRoots(await ctx.bookmarks.getTree());
  const root = roots[0];
  if (!root) throw new Error('browser has no syncable bookmark roots');
  return root.id;
}

/** First child on this parent with matching content and no mapping yet. */
async function findUnmappedMatch(
  ctx: EngineEnv,
  parentBrowserId: string,
  title: string,
  url: string | undefined,
): Promise<BookmarkNodeLite | undefined> {
  for (const child of await ctx.bookmarks.getChildren(parentBrowserId)) {
    if (child.title !== title || child.url !== url) continue;
    if (!(await ctx.stores.mappings.get(child.id))) return child;
  }
  return undefined;
}

/**
 * Native-tree index for a fractional key: the number of siblings that sort
 * before it by (sortOrder, uuid) — the uuid tie-break matches the server's
 * tree ordering, so devices that generated identical keys concurrently still
 * converge on the same visible order. Siblings without a mapped key
 * (brand-new local nodes) keep their position by not being counted.
 */
async function indexForSortOrder(
  ctx: EngineEnv,
  parentBrowserId: string,
  sortOrder: string,
  uuid: string,
  excludeBrowserId: string | undefined,
): Promise<number> {
  let index = 0;
  for (const sibling of await ctx.bookmarks.getChildren(parentBrowserId)) {
    if (sibling.id === excludeBrowserId) continue;
    const mapping = await ctx.stores.mappings.get(sibling.id);
    if (!mapping) continue;
    if (
      mapping.sortOrder < sortOrder ||
      (mapping.sortOrder === sortOrder && mapping.uuid !== undefined && mapping.uuid < uuid)
    ) {
      index += 1;
    }
  }
  return index;
}
