import { ApiClient } from '../api/client.js';
import { chromeBookmarksApi } from '../chrome/bookmarksApi.js';
import { idbStores } from '../storage/idb.js';
import { SyncEngine } from '../sync/engine.js';
import { getSyncInterval } from '../ui/settings.js';

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

/** Toolbar badge: red ! on errors, ? while awaiting the first-sync choice,
 * queue depth while edits wait for upload, empty when all is well. */
async function refreshBadge(): Promise<void> {
  const status = await engine.status();
  let text = '';
  let color = '#1a73e8';
  if (status.lastError !== undefined) {
    text = '!';
    color = '#b00020';
  } else if (status.pendingInitialChoice) {
    text = '?';
    color = '#b45309';
  } else if (status.queueDepth > 0) {
    text = status.queueDepth > 999 ? '999+' : String(status.queueDepth);
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function syncAndBadge(options?: { force?: boolean; reconcile?: boolean }): Promise<void> {
  return engine
    .sync(options)
    .then(refreshBadge)
    .catch((error: unknown) => console.warn('[nodefav] badge refresh failed', error));
}

/**
 * Debounced sync shortly after a burst of edits. setTimeout is best-effort in a
 * service worker; the periodic alarm below is the durable backstop.
 */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function syncSoon(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncAndBadge(), 500);
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

/** (Re)creates the periodic alarm from the configured interval. */
async function scheduleAlarm(): Promise<void> {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: await getSyncInterval() });
}

function bootstrap(): void {
  void scheduleAlarm();
  void syncAndBadge();
}
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void syncAndBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('syncIntervalMinutes' in changes) void scheduleAlarm();
  if ('serverUrl' in changes || 'token' in changes) syncSoon();
});

// Options/popup RPC: status snapshot, manual sync, drift check, first-sync merge choice.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const { type, choice } = (message ?? {}) as { type?: string; choice?: string };
  const respondWithStatus = (work: Promise<unknown>): void => {
    work
      .then(() => refreshBadge())
      .then(() => engine.status())
      .then(sendResponse, (error) => sendResponse({ error: String(error) }));
  };
  if (type === 'nodefav:status') {
    respondWithStatus(Promise.resolve());
    return true;
  }
  if (type === 'nodefav:syncNow') {
    respondWithStatus(engine.sync({ force: true }));
    return true;
  }
  if (type === 'nodefav:reconcile') {
    respondWithStatus(engine.sync({ force: true, reconcile: true }));
    return true;
  }
  if (type === 'nodefav:initialChoice') {
    if (choice !== 'keep-local' && choice !== 'keep-cloud' && choice !== 'merge') {
      sendResponse({ error: `unknown choice ${String(choice)}` });
      return true;
    }
    respondWithStatus(engine.resolveInitialChoice(choice));
    return true;
  }
  return undefined;
});
