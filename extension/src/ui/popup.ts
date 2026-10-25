import type { SyncStatus } from '../sync/engine.js';
import type { RealtimeState } from '../sync/realtime.js';
import { chromeBookmarksApi, type BookmarkNodeLite } from '../chrome/bookmarksApi.js';
import { syncableRoots } from '../sync/context.js';
import { getSyncInterval } from './settings.js';

type UiStatus = SyncStatus & { realtime?: RealtimeState };
type Bookmark = BookmarkNodeLite;

const search = document.getElementById('search') as HTMLInputElement;
const items = document.getElementById('items') as HTMLElement;
const back = document.getElementById('back') as HTMLButtonElement;
const folderName = document.getElementById('folderName') as HTMLElement;
const settings = document.getElementById('settingsPanel') as HTMLElement;
const settingsToggle = document.getElementById('settingsToggle') as HTMLButtonElement;
if (location.pathname.endsWith('/browse.html')) {
  (document.getElementById('openTab') as HTMLButtonElement).hidden = true;
}
const statusList = document.getElementById('status') as HTMLDListElement;
const message = document.getElementById('message') as HTMLParagraphElement;
let tree: Bookmark[] = [];
let currentId: string | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function findNode(
  id: string | null,
  nodes: Bookmark[] = syncableRoots(tree),
): Bookmark | undefined {
  if (id === null) return undefined;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(id, node.children ?? []);
    if (child) return child;
  }
}

function row(node: Bookmark, path = ''): HTMLElement {
  const folder = !node.url;
  const item = element(folder ? 'button' : 'a', 'item');
  if (folder) {
    (item as HTMLButtonElement).type = 'button';
    item.addEventListener('click', () => {
      currentId = node.id;
      search.value = '';
      render();
    });
  } else {
    const link = item as HTMLAnchorElement;
    link.href = node.url!;
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
  const symbol = element('span', 'symbol');
  symbol.textContent = folder ? '📁' : '🔖';
  const text = element('span', 'text');
  const title = element('span', 'title');
  title.textContent = node.title || node.url || '(untitled)';
  text.append(title);
  if (path || node.url) {
    const subtitle = element('span', 'subtitle');
    subtitle.textContent = path || node.url || '';
    text.append(subtitle);
  }
  item.append(symbol, text);
  return item;
}

function render(): void {
  const query = search.value.trim().toLocaleLowerCase();
  const rows: HTMLElement[] = [];
  if (query) {
    const walk = (node: Bookmark, parents: string[]): void => {
      const path = parents.join(' / ');
      if (
        node.title.toLocaleLowerCase().includes(query) ||
        node.url?.toLocaleLowerCase().includes(query)
      ) {
        rows.push(row(node, path));
      }
      for (const child of node.children ?? []) walk(child, [...parents, node.title]);
    };
    for (const node of syncableRoots(tree)) walk(node, []);
    back.hidden = true;
    folderName.textContent = `Search results (${rows.length})`;
  } else {
    const children = currentId ? (findNode(currentId)?.children ?? []) : syncableRoots(tree);
    rows.push(...children.map((node) => row(node)));
    back.hidden = currentId === null;
    folderName.textContent = findNode(currentId)?.title || 'All bookmarks';
  }
  if (rows.length === 0) {
    const empty = element('p', 'empty');
    empty.textContent = query ? 'No matching bookmarks.' : 'No bookmarks in this folder.';
    rows.push(empty);
  }
  items.replaceChildren(...rows);
}

async function loadBookmarks(): Promise<void> {
  try {
    tree = await chromeBookmarksApi().getTree();
    if (currentId && !findNode(currentId)) currentId = null;
    render();
  } catch (error) {
    items.textContent = `Could not load bookmarks: ${String(error)}`;
  }
}

function ago(timestamp: number | undefined): string {
  if (timestamp === undefined) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(timestamp).toLocaleString();
}

async function refresh(type: 'nodefav:status' | 'nodefav:syncNow'): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type })) as UiStatus | { error: string };
    if ('error' in response) throw new Error(response.error);
    message.textContent = '';
    const interval = await getSyncInterval();
    const rows: Array<[string, string]> = [
      ['Last sync', ago(response.lastSyncAt)],
      ['Queued edits', String(response.queueDepth)],
      ['Realtime', response.realtime ?? 'off'],
      ['Sync interval', `${interval} min`],
      ['Drift', response.lastDrift ?? 'none found'],
      ...(response.pendingInitialChoice
        ? [['Attention', 'first-sync choice needed in options'] as [string, string]]
        : []),
      ...(response.lastError ? [['Error', response.lastError] as [string, string]] : []),
    ];
    statusList.replaceChildren(
      ...rows.flatMap(([name, value]) => {
        const dt = element('dt');
        dt.textContent = name;
        const dd = element('dd');
        dd.textContent = value;
        if (name === 'Error' || name === 'Attention') dd.className = 'error';
        return [dt, dd];
      }),
    );
  } catch (error) {
    message.textContent = String(error);
    message.className = 'error';
  }
}

search.addEventListener('input', render);
back.addEventListener('click', () => {
  const parentId = findNode(currentId)?.parentId;
  currentId = parentId === tree[0]?.id ? null : (parentId ?? null);
  render();
});
settingsToggle.addEventListener('click', () => {
  settings.hidden = !settings.hidden;
  settingsToggle.setAttribute('aria-expanded', String(!settings.hidden));
  if (!settings.hidden) void refresh('nodefav:status');
});
document.getElementById('syncNow')?.addEventListener('click', () => {
  message.textContent = 'Syncing…';
  message.className = '';
  void refresh('nodefav:syncNow');
});
document.getElementById('openManage')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
});
document
  .getElementById('openOptions')
  ?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.getElementById('openTab')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
});
chrome.bookmarks.onCreated.addListener(() => void loadBookmarks());
chrome.bookmarks.onChanged.addListener(() => void loadBookmarks());
chrome.bookmarks.onMoved.addListener(() => void loadBookmarks());
chrome.bookmarks.onRemoved.addListener(() => void loadBookmarks());
void loadBookmarks();
setInterval(() => {
  if (!settings.hidden) void refresh('nodefav:status');
}, 2000);
