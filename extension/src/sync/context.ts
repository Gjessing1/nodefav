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

/** The browser's permanent root folders that participate in sync (managed roots don't). */
export function syncableRoots(tree: BookmarkNodeLite[]): BookmarkNodeLite[] {
  return (tree[0]?.children ?? []).filter((root) => !root.unmodifiable);
}
