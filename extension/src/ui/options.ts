import type { SyncStatus } from '../sync/engine.js';

const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const message = document.getElementById('message') as HTMLParagraphElement;
const statusList = document.getElementById('status') as HTMLDListElement;

async function loadConfig(): Promise<void> {
  const { serverUrl, token } = (await chrome.storage.local.get(['serverUrl', 'token'])) as {
    serverUrl?: string;
    token?: string;
  };
  serverUrlInput.value = serverUrl ?? '';
  tokenInput.value = token ?? '';
}

async function save(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ serverUrl, token });
  message.textContent = 'Saved.';
  message.className = '';
  await syncNow();
}

async function syncNow(): Promise<void> {
  message.textContent = 'Syncing…';
  message.className = '';
  const response = (await chrome.runtime.sendMessage({ type: 'nodefav:syncNow' })) as
    SyncStatus | { error: string };
  if ('error' in response) {
    message.textContent = response.error;
    message.className = 'error';
  } else {
    message.textContent = response.lastError ?? 'Sync finished.';
    message.className = response.lastError ? 'error' : '';
    renderStatus(response);
  }
}

async function refreshStatus(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: 'nodefav:status' })) as
    SyncStatus | { error: string };
  if (!('error' in response)) renderStatus(response);
}

function renderStatus(status: SyncStatus): void {
  const rows: Array<[string, string]> = [
    ['Configured', status.configured ? 'yes' : 'no'],
    ['Initialized', status.initialized ? 'yes' : 'no'],
    ['Queued ops', String(status.queueDepth)],
    ['Mapped bookmarks', String(status.mappingCount)],
    ['Sync cursor', String(status.cursor)],
    ['Last sync', status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'never'],
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
document.getElementById('syncNow')?.addEventListener('click', () => void syncNow());
void loadConfig();
void refreshStatus();
setInterval(() => void refreshStatus(), 3000);
