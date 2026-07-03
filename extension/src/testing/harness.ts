import type { BookmarkNode } from '@nodefav/shared';
import { memoryStores } from '../storage/memory.js';
import type { SyncStores } from '../storage/types.js';
import type { EngineEnv } from '../sync/context.js';
import { SyncEngine } from '../sync/engine.js';
import { FakeBookmarks } from './fakeBookmarks.js';
import { FakeSyncServer } from './fakeServer.js';

export interface Harness {
  fake: FakeBookmarks;
  server: FakeSyncServer;
  stores: SyncStores;
  engine: SyncEngine;
  logged: string[];
}

/**
 * A wired-up client: fake browser + fake server + durable stores + engine,
 * with bookmark events routed into the engine exactly like background/index.ts
 * does with real chrome.bookmarks events.
 */
export function createHarness(
  options: { fake?: FakeBookmarks; server?: FakeSyncServer; stores?: SyncStores } = {},
): Harness {
  const fake = options.fake ?? new FakeBookmarks();
  const server = options.server ?? new FakeSyncServer();
  const stores = options.stores ?? memoryStores();
  const logged: string[] = [];
  const env: EngineEnv = {
    bookmarks: fake,
    stores,
    getApi: () => Promise.resolve(server),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log: (message) => logged.push(message),
  };
  const engine = new SyncEngine(env);
  fake.onCreated((id, node) => void engine.handleCreated(id, node));
  fake.onChanged((id, info) => void engine.handleChanged(id, info));
  fake.onMoved((id, info) => void engine.handleMoved(id, info));
  fake.onRemoved((id, info) => void engine.handleRemoved(id, info));
  return { fake, server, stores, engine, logged };
}

/**
 * Simulates a service-worker death and restart: the browser tree, the server
 * and the durable stores survive; the engine, its in-memory state and all
 * event listeners do not.
 */
export function restartWorker(harness: Harness): Harness {
  harness.fake.resetListeners();
  return createHarness({ fake: harness.fake, server: harness.server, stores: harness.stores });
}

/** Server-side live tree as plain data, comparable with FakeBookmarks.snapshot(). */
export async function serverSnapshot(
  server: FakeSyncServer,
): Promise<Array<{ title: string; url?: string; children?: unknown[] }>> {
  const { roots } = await server.getBookmarks();
  const toPlain = (node: BookmarkNode): { title: string; url?: string; children?: unknown[] } => ({
    title: node.title,
    ...(node.type === 'bookmark' ? { url: node.url ?? '' } : {}),
    ...(node.type === 'folder' ? { children: (node.children ?? []).map(toPlain) } : {}),
  });
  return roots.map(toPlain);
}
