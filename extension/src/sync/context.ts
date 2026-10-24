import type { SyncApi } from '../api/client.js';
import type { BookmarkNodeLite, BookmarksApi } from '../chrome/bookmarksApi.js';
import type { SyncStores } from '../storage/types.js';

/** Chromium's invisible root — its children are the permanent roots (Bookmarks
 * bar, Other bookmarks, …). Cloud-side they map to root-level folders (parentUuid null). */
export const BROWSER_ROOT_ID = '0';

/** Everything the sync engine needs from the outside world, injectable for tests. */
export interface EngineEnv {
  bookmarks: BookmarksApi;
  stores: SyncStores;
  /** Null while the extension is unconfigured (no server URL / token yet). */
  getApi(): Promise<SyncApi | null>;
  now(): number;
  /** Fresh unique id — used for op ids and the device id. */
  newId(): string;
  log(message: string, detail?: unknown): void;
}

export const META = {
  deviceId: 'deviceId',
  initialized: 'initialized',
  cursor: 'cursor',
  lastSyncAt: 'lastSyncAt',
  lastError: 'lastError',
  failureCount: 'failureCount',
  nextAttemptAt: 'nextAttemptAt',
  /** Both sides non-empty at first sync — waiting for the user's merge choice. */
  pendingChoice: 'pendingChoice',
  /** When the drift-detection pass last completed (skips don't count). */
  lastReconcileAt: 'lastReconcileAt',
  /** Human-readable summary of the last drift found; absent while clean. */
  lastDrift: 'lastDrift',
  excludedRootIds: 'excludedRootIds',
} as const;

export async function getDeviceId(ctx: EngineEnv): Promise<string> {
  const existing = await ctx.stores.meta.get<string>(META.deviceId);
  if (existing !== undefined) return existing;
  const deviceId = ctx.newId();
  await ctx.stores.meta.set(META.deviceId, deviceId);
  return deviceId;
}

export async function isInitialized(ctx: EngineEnv): Promise<boolean> {
  return (await ctx.stores.meta.get<boolean>(META.initialized)) === true;
}

/**
 * Browser-owned roots are not all user bookmark collections. Edge Workspaces
 * and browser trash are internal stores. Vivaldi exposes Chromium's "Other
 * bookmarks" root to extensions although its bookmark UI does not show it;
 * its Trash root distinguishes that profile from the ordinary Chromium tree.
 */
export function syncableRoots(tree: BookmarkNodeLite[]): BookmarkNodeLite[] {
  const roots = tree[0]?.children ?? [];
  return roots.filter((root) => !root.unmodifiable && syncableRootTitle(tree, root.title));
}

/** Apply the same root policy to cloud roots before replaying them locally. */
export function syncableRootTitle(tree: BookmarkNodeLite[], title: string): boolean {
  const titles = new Set((tree[0]?.children ?? []).map((root) => root.title.trim().toLowerCase()));
  const vivaldiLayout = titles.has('trash') && !titles.has('speed dial');
  const edgeLayout = titles.has('other favourites') || titles.has('other favorites');
  const normalized = title.trim().toLowerCase();
  if (
    normalized === 'workspaces' ||
    normalized === 'trash' ||
    normalized === 'deleted' ||
    normalized === 'other favourites' ||
    normalized === 'other favorites'
  )
    return false;
  if ((vivaldiLayout || edgeLayout) && normalized === 'other bookmarks') return false;
  return true;
}

/** Whether a native node lives below a root that participates in sync. */
export async function isSyncableLocation(ctx: EngineEnv, browserId: string): Promise<boolean> {
  const roots = syncableRoots(await ctx.bookmarks.getTree());
  const allowed = new Set(roots.map((root) => root.id));
  let id = browserId;
  while (id !== BROWSER_ROOT_ID) {
    if (allowed.has(id)) return true;
    const node = await ctx.bookmarks.get(id);
    if (!node?.parentId) return false;
    id = node.parentId;
  }
  return false;
}

/** Remove stale local state for roots that an older version synchronized. */
export async function excludeUnsyncableRoots(ctx: EngineEnv): Promise<void> {
  const tree = await ctx.bookmarks.getTree();
  const allowed = new Set(syncableRoots(tree).map((root) => root.id));
  const excluded = (tree[0]?.children ?? []).filter((root) => !allowed.has(root.id));
  const migrated = new Set((await ctx.stores.meta.get<string[]>(META.excludedRootIds)) ?? []);
  for (const root of excluded) {
    if (migrated.has(root.id)) continue;
    await ctx.stores.mappings.removeSubtree(root.id);
    migrated.add(root.id);
  }
  await ctx.stores.meta.set(META.excludedRootIds, [...migrated]);
  // The uploader discards queued edits whose native location is excluded.
}
