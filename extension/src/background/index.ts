import { ApiClient } from '../api/client.js';
import { chromeBookmarksApi } from '../chrome/bookmarksApi.js';
import { idbStores } from '../storage/idb.js';
import { SyncEngine } from '../sync/engine.js';

const engine = new SyncEngine({
  bookmarks: chromeBookmarksApi(),
  stores: idbStores(),
  getApi: async () => {
    const { serverUrl, token } = (await chrome.storage.local.get(['serverUrl', 'token'])) as {
      serverUrl?: string;
      token?: string;
    };
    return serverUrl && token ? new ApiClient({ serverUrl, token }) : null;
  },
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  log: (message, detail) => console.warn(`[nodefav] ${message}`, detail ?? ''),
});

const SYNC_ALARM = 'nodefav-sync';

/**
 * Debounced sync shortly after a burst of edits. setTimeout is best-effort in a
 * service worker; the periodic alarm below is the durable backstop.
 */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function syncSoon(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void engine.sync(), 500);
}

// Listeners are registered synchronously at the top level, as MV3 requires.
chrome.bookmarks.onCreated.addListener((id, node) => {
  void engine.handleCreated(id, node).then(syncSoon);
});
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  void engine.handleChanged(id, changeInfo).then(syncSoon);
});
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  void engine.handleMoved(id, moveInfo).then(syncSoon);
});
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  void engine.handleRemoved(id, removeInfo).then(syncSoon);
});

function bootstrap(): void {
  void chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  void engine.sync();
}
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void engine.sync();
});

// Options-page RPC: status snapshot and manual sync.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;
  if (type === 'nodefav:status') {
    engine.status().then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true;
  }
  if (type === 'nodefav:syncNow') {
    engine
      .sync({ force: true })
      .then(() => engine.status())
      .then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true;
  }
  return undefined;
});
