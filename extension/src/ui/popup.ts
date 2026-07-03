import type { SyncStatus } from '../sync/engine.js';
import { getSyncInterval } from './settings.js';

const statusList = document.getElementById('status') as HTMLDListElement;
const message = document.getElementById('message') as HTMLParagraphElement;

function ago(timestamp: number | undefined): string {
  if (timestamp === undefined) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(timestamp).toLocaleString();
}

async function render(status: SyncStatus): Promise<void> {
  const interval = await getSyncInterval();
  const rows: Array<[string, string, boolean]> = [
    ['Last sync', ago(status.lastSyncAt), false],
    ['Queued edits', String(status.queueDepth), false],
    ['Sync interval', `${interval} min`, false],
    ['Drift', status.lastDrift ?? 'none found', false],
    ...(status.pendingInitialChoice
      ? [['Attention', 'first-sync choice needed in options', true] as [string, string, boolean]]
      : []),
    ...(status.lastError !== undefined
      ? [['Error', status.lastError, true] as [string, string, boolean]]
      : []),
  ];
  statusList.replaceChildren(
    ...rows.flatMap(([term, value, isError]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (isError) dd.className = 'error';
      return [dt, dd];
    }),
  );
}

async function refresh(type: 'nodefav:status' | 'nodefav:syncNow'): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type })) as SyncStatus | { error: string };
  if ('error' in response) {
    message.textContent = response.error;
    message.className = 'error';
  } else {
    message.textContent = '';
    await render(response);
  }
}

document.getElementById('syncNow')?.addEventListener('click', () => {
  message.textContent = 'Syncing…';
  message.className = '';
  void refresh('nodefav:syncNow');
});
document.getElementById('openOptions')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});
void refresh('nodefav:status');
setInterval(() => void refresh('nodefav:status'), 2000);
