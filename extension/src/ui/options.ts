import type { SyncStatus } from '../sync/engine.js';
import type { RealtimeState } from '../sync/realtime.js';
import { getSyncInterval, normalizeSyncInterval } from './settings.js';
import { chromeBookmarksApi, type BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { syncableRoots } from '../sync/context.js';

/** Engine snapshot augmented by the background with the realtime feed state. */
type UiStatus = SyncStatus & { realtime?: RealtimeState };

const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const syncIntervalInput = document.getElementById('syncInterval') as HTMLInputElement;
const deviceNameInput = document.getElementById('deviceName') as HTMLInputElement;
const browseStartInput = document.getElementById('browseStartFolder') as HTMLSelectElement;
const message = document.getElementById('message') as HTMLParagraphElement;
const statusList = document.getElementById('status') as HTMLDListElement;
const chooser = document.getElementById('chooser') as HTMLElement;

async function loadConfig(): Promise<void> {
  const { serverUrl, token } = (await chrome.storage.local.get(['serverUrl', 'token'])) as {
    serverUrl?: string;
    token?: string;
  };
  serverUrlInput.value = serverUrl ?? '';
  tokenInput.value = token ?? '';
  syncIntervalInput.value = String(await getSyncInterval());
  await loadBrowseFolders();
  const device = (await chrome.runtime.sendMessage({ type: 'nodefav:device' })) as
    { deviceId: string; name: string; version: string } | { error: string };
  if (!('error' in device)) {
    deviceNameInput.value = device.name;
    setText('version', `v${device.version}`);
    setText('deviceId', `Device ID: ${device.deviceId}`);
  }
}

async function loadBrowseFolders(): Promise<void> {
  const [tree, stored] = await Promise.all([
    chromeBookmarksApi().getTree(),
    chrome.storage.local.get('browseStartFolder') as Promise<{ browseStartFolder?: string }>,
  ]);
  const choice = (value: string, label: string): HTMLOptionElement => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  };
  browseStartInput.replaceChildren(
    choice('auto', 'Automatic (open the only bookmark root)'),
    choice('all', 'All bookmarks'),
  );
  const appendFolders = (nodes: BookmarkNodeLite[], path: string[]): void => {
    for (const node of nodes) {
      if (node.url) continue;
      const label = [...path, node.title];
      browseStartInput.append(choice(`folder:${node.id}`, label.join(' / ')));
      appendFolders(node.children ?? [], label);
    }
  };
  appendFolders(syncableRoots(tree), []);
  const preference = stored.browseStartFolder ?? 'auto';
  browseStartInput.value = [...browseStartInput.options].some(
    (option) => option.value === preference,
  )
    ? preference
    : 'auto';
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

async function save(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  const syncIntervalMinutes = normalizeSyncInterval(syncIntervalInput.value);
  syncIntervalInput.value = String(syncIntervalMinutes);
  const deviceName = deviceNameInput.value.trim().slice(0, 100);
  await chrome.storage.local.set({
    serverUrl,
    token,
    syncIntervalMinutes,
    ...(deviceName ? { deviceName } : {}),
  });
  message.textContent = 'Saved.';
  message.className = '';
  await syncNow('nodefav:syncNow');
}

async function syncNow(type: 'nodefav:syncNow' | 'nodefav:reconcile'): Promise<void> {
  message.textContent = type === 'nodefav:reconcile' ? 'Checking consistency…' : 'Syncing…';
  message.className = '';
  const response = (await chrome.runtime.sendMessage({ type })) as UiStatus | { error: string };
  if ('error' in response) {
    message.textContent = response.error;
    message.className = 'error';
  } else {
    message.textContent =
      response.lastError ??
      (type === 'nodefav:reconcile' ? (response.lastDrift ?? 'No drift found.') : 'Sync finished.');
    message.className = response.lastError ? 'error' : '';
    renderStatus(response);
  }
}

async function refreshStatus(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: 'nodefav:status' })) as
    UiStatus | { error: string };
  if (!('error' in response)) renderStatus(response);
}

async function sendChoice(choice: 'keep-local' | 'keep-cloud' | 'merge'): Promise<void> {
  message.textContent = 'Applying choice and syncing…';
  message.className = '';
  const response = (await chrome.runtime.sendMessage({ type: 'nodefav:initialChoice', choice })) as
    UiStatus | { error: string };
  if ('error' in response) {
    message.textContent = response.error;
    message.className = 'error';
  } else {
    message.textContent = response.lastError ?? 'Bookmarks combined.';
    message.className = response.lastError ? 'error' : '';
    renderStatus(response);
  }
}

function renderStatus(status: UiStatus): void {
  chooser.hidden = !status.pendingInitialChoice;
  const when = (t: number | undefined): string => (t ? new Date(t).toLocaleString() : 'never');
  const rows: Array<[string, string]> = [
    ['Configured', status.configured ? 'yes' : 'no'],
    ['Initialized', status.initialized ? 'yes' : 'no'],
    ['Queued ops', String(status.queueDepth)],
    ['Mapped bookmarks', String(status.mappingCount)],
    ['Sync cursor', String(status.cursor)],
    ['Realtime', status.realtime ?? 'off'],
    ['Last sync', when(status.lastSyncAt)],
    ['Last drift check', when(status.lastReconcileAt)],
    ['Drift', status.lastDrift ?? '—'],
    ['Last error', status.lastError ?? '—'],
  ];
  statusList.replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

document.getElementById('save')?.addEventListener('click', () => void save());
browseStartInput.addEventListener('change', () => {
  void chrome.storage.local.set({ browseStartFolder: browseStartInput.value }).then(() => {
    message.textContent = 'Start folder saved.';
    message.className = '';
  });
});
document
  .getElementById('syncNow')
  ?.addEventListener('click', () => void syncNow('nodefav:syncNow'));
document
  .getElementById('reconcile')
  ?.addEventListener('click', () => void syncNow('nodefav:reconcile'));
document.getElementById('chooseMerge')?.addEventListener('click', () => void sendChoice('merge'));
document
  .getElementById('chooseKeepLocal')
  ?.addEventListener('click', () => void sendChoice('keep-local'));
document
  .getElementById('chooseKeepCloud')
  ?.addEventListener('click', () => void sendChoice('keep-cloud'));
void loadConfig();
void refreshStatus();
setInterval(() => void refreshStatus(), 3000);
