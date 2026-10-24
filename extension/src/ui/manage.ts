import type {
  BookmarkNode,
  DeviceInfo,
  GetStatsResponse,
  MetaItem,
  SyncOp,
  TrashItem,
} from '@nodefav/shared';
import { ApiClient } from '../api/client.js';
import { syncableRootTitle } from '../sync/context.js';
import { compareVersions } from './device.js';
import {
  countDescendants,
  endKey,
  folderChoices,
  indexTree,
  searchTree,
  shiftKey,
  sortNodes,
  trashGroups,
} from './manageModel.js';

/**
 * Admin page: the cloud's view of everything — tree editor, trash with
 * restore, device list. Edits are ordinary ops posted to the cloud under an
 * `admin:` device id, so every browser (this one included) applies them
 * through the normal pull path.
 */

/** An op before it is stamped with id, device and time (distributes over the union). */
type OpDraft = SyncOp extends infer T
  ? T extends SyncOp
    ? Omit<T, 'opId' | 'deviceId' | 'timestamp'>
    : never
  : never;

interface Data {
  roots: BookmarkNode[];
  meta: Map<string, MetaItem>;
  trash: TrashItem[];
  devices: DeviceInfo[];
  stats: GetStatsResponse;
}

let api: ApiClient | null = null;
let self: { deviceId: string; version: string } = { deviceId: '', version: '0' };
let data: Data | null = null;
let localTree: chrome.bookmarks.BookmarkTreeNode[] = [];
/** Folders the user expanded — kept across re-renders. */
const open = new Set<string>();
/** Row currently showing an inline form: edit an existing node, or add into a folder. */
let editing: { mode: 'edit' | 'add-bookmark' | 'add-folder'; uuid: string } | null = null;

const message = document.getElementById('message') as HTMLParagraphElement;
const search = document.getElementById('search') as HTMLInputElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function say(text: string, error = false): void {
  message.textContent = text;
  message.className = error ? 'error' : '';
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

async function load(): Promise<void> {
  const { serverUrl, token } = (await chrome.storage.local.get(['serverUrl', 'token'])) as {
    serverUrl?: string;
    token?: string;
  };
  if (!serverUrl || !token) {
    say('Set the server URL and token in the nodefav options first.', true);
    return;
  }
  api = new ApiClient({ serverUrl, token });
  const device = (await chrome.runtime.sendMessage({ type: 'nodefav:device' })) as
    { deviceId: string; version: string } | { error: string };
  if (!('error' in device)) self = device;
  localTree = (await chrome.bookmarks.getTree()) ?? [];
  await refresh();
}

async function refresh(): Promise<void> {
  if (!api) return;
  try {
    const [tree, meta, trash, devices, stats] = await Promise.all([
      api.getBookmarks(),
      api.getMeta(),
      api.getTrash(),
      api.getDevices(),
      api.getStats(),
    ]);
    data = {
      roots: tree.roots,
      meta: new Map(meta.items.map((item) => [item.uuid, item])),
      trash: trash.items,
      devices: devices.devices,
      stats,
    };
    if (open.size === 0) for (const root of tree.roots) open.add(root.uuid);
    render();
  } catch (error) {
    say(`Could not load from the server: ${String(error)}`, true);
  }
}

/** Posts ops to the cloud, then nudges this browser to pull them right away. */
async function send(ops: OpDraft[]): Promise<boolean> {
  if (!api) return false;
  const stamped = ops.map(
    (op) =>
      ({
        ...op,
        opId: crypto.randomUUID(),
        deviceId: `admin:${self.deviceId}`,
        timestamp: Date.now(),
      }) as SyncOp,
  );
  try {
    const { results } = await api.postOps(stamped);
    const failed = results.filter((result) => result.status !== 'applied');
    if (failed.length > 0) {
      say(`Not applied: ${failed.map((f) => f.error ?? f.status).join('; ')}`, true);
      return false;
    }
    void chrome.runtime.sendMessage({ type: 'nodefav:syncNow' }).catch(() => undefined);
    return true;
  } catch (error) {
    say(String(error), true);
    return false;
  } finally {
    await refresh();
  }
}

function render(): void {
  if (!data) return;
  const { stats } = data;
  const deadCount = [...data.meta.values()].filter((item) => item.health === 'dead').length;
  const trashCount = trashGroups(data.trash).length;
  (document.getElementById('summary') as HTMLElement).textContent =
    `${stats.bookmarks.live} live nodes · ${deadCount} dead links · ` +
    `${trashCount} in trash · ${data.devices.length} devices · server v${stats.serverVersion}`;
  renderBookmarks();
  renderTrash();
  renderDevices();
}

// ---------------------------------------------------------------- bookmarks

function renderBookmarks(): void {
  if (!data) return;
  const container = document.getElementById('tree') as HTMLElement;
  const query = search.value;
  if (query.trim() !== '') {
    const hits = searchTree(data.roots, query);
    container.replaceChildren(
      hits.length === 0
        ? el('p', { className: 'empty', textContent: 'No matches.' })
        : el(
            'ul',
            { className: 'tree' },
            ...hits.map((hit) =>
              el(
                'li',
                {},
                el('div', { className: 'path', textContent: hit.path.join(' / ') }),
                ...nodeRow(hit.node),
              ),
            ),
          ),
    );
    return;
  }
  container.replaceChildren(
    el('ul', { className: 'tree' }, ...sortNodes(data.roots).map((root) => nodeItem(root))),
  );
}

function nodeItem(node: BookmarkNode): HTMLLIElement {
  if (node.type !== 'folder') return el('li', { className: 'leaf' }, ...nodeRow(node));
  const details = el('details', { open: open.has(node.uuid) });
  details.addEventListener('toggle', () => {
    if (details.open) open.add(node.uuid);
    else open.delete(node.uuid);
  });
  const [row, ...forms] = nodeRow(node);
  details.append(el('summary', {}, row!));
  details.append(...forms);
  const children = sortNodes(node.children ?? []);
  details.append(
    children.length === 0
      ? el('p', { className: 'empty', textContent: 'Empty folder' })
      : el('ul', {}, ...children.map((child) => nodeItem(child))),
  );
  return el('li', {}, details);
}

/** The row for a node, followed by its inline form when one is open. */
function nodeRow(node: BookmarkNode): HTMLElement[] {
  if (!data) return [];
  const isRoot = node.parentUuid === null;
  const meta = data.meta.get(node.uuid);
  const row = el('div', { className: 'row' });

  if (node.type === 'folder') {
    row.append(el('span', { className: 'caret', textContent: '▶' }));
    row.append(el('span', { className: 'icon', textContent: '📁' }));
  } else if (meta?.faviconUrl) {
    const icon = el('img', { className: 'icon', src: meta.faviconUrl, alt: '' });
    icon.addEventListener('error', () => icon.replaceWith(el('span', { className: 'icon' })));
    row.append(icon);
  } else {
    row.append(el('span', { className: 'icon', textContent: '🔖' }));
  }
  row.append(el('span', { className: 'title', textContent: node.title || '(untitled)' }));

  if (node.type === 'folder') {
    row.append(
      el('span', { className: 'badge muted', textContent: String(countDescendants(node)) }),
    );
    if (isRoot && !syncableRootTitle(localTree, node.title)) {
      row.append(el('span', { className: 'badge muted', textContent: 'not synced here' }));
    }
    row.append(el('span', { className: 'spacer' }));
  } else {
    if (meta?.health === 'dead' || meta?.health === 'failing') {
      row.append(
        el('span', {
          className: `badge ${meta.health}`,
          textContent: meta.health,
          title: meta.httpStatus ? `HTTP ${meta.httpStatus}` : 'no response',
        }),
      );
    }
    row.append(
      el('a', {
        className: 'url',
        href: node.url ?? '#',
        target: '_blank',
        rel: 'noreferrer',
        textContent: node.url ?? '',
      }),
    );
  }

  const actions = el('span', { className: 'actions' });
  const action = (label: string, title: string, run: () => void): void => {
    const button = el('button', { className: 'small', textContent: label, title });
    button.addEventListener('click', (event) => {
      event.preventDefault(); // keep <summary> from toggling
      run();
    });
    actions.append(button);
  };
  if (node.type === 'folder') {
    action('+ Bookmark', 'Add a bookmark at the end of this folder', () =>
      openForm('add-bookmark', node.uuid),
    );
    action('+ Folder', 'Add a subfolder at the end of this folder', () =>
      openForm('add-folder', node.uuid),
    );
  }
  if (!isRoot) {
    action('↑', 'Move up', () => void shift(node, -1));
    action('↓', 'Move down', () => void shift(node, 1));
    action('Edit', 'Rename, change URL or move to another folder', () =>
      openForm('edit', node.uuid),
    );
    action('Delete', 'Move to trash', () => void remove(node));
  }
  row.append(actions);

  const forms: HTMLElement[] = [];
  if (editing?.uuid === node.uuid) forms.push(editorForm(node, editing.mode));
  return [row, ...forms];
}

function openForm(mode: 'edit' | 'add-bookmark' | 'add-folder', uuid: string): void {
  editing = { mode, uuid };
  open.add(uuid);
  renderBookmarks();
  (document.querySelector('form.editor input') as HTMLInputElement | null)?.focus();
}

function editorForm(node: BookmarkNode, mode: 'edit' | 'add-bookmark' | 'add-folder'): HTMLElement {
  if (!data) return el('div');
  const wantsUrl = mode === 'add-bookmark' || (mode === 'edit' && node.type === 'bookmark');
  const title = el('input', {
    type: 'text',
    value: mode === 'edit' ? node.title : '',
    placeholder: mode === 'add-folder' ? 'Folder name' : 'Title',
    required: true,
  });
  const url = el('input', {
    type: 'url',
    value: mode === 'edit' ? (node.url ?? '') : '',
    placeholder: 'https://…',
    required: true,
  });
  const parent = el('select');
  if (mode === 'edit') {
    for (const choice of folderChoices(data.roots, node.uuid)) {
      parent.append(
        el('option', {
          value: choice.uuid,
          textContent: choice.label,
          selected: choice.uuid === node.parentUuid,
        }),
      );
    }
  }
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  cancel.addEventListener('click', () => {
    editing = null;
    renderBookmarks();
  });
  const form = el(
    'form',
    { className: 'editor' },
    el('label', { textContent: mode === 'add-folder' ? 'Name' : 'Title' }),
    title,
    ...(wantsUrl ? [el('label', { textContent: 'URL' }), url] : []),
    ...(mode === 'edit' ? [el('label', { textContent: 'Folder' }), parent] : []),
    el(
      'div',
      { className: 'buttons' },
      el('button', { type: 'submit', textContent: mode === 'edit' ? 'Save' : 'Add' }),
      cancel,
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitForm(node, mode, title.value.trim(), url.value.trim(), parent.value);
  });
  return form;
}

async function submitForm(
  node: BookmarkNode,
  mode: 'edit' | 'add-bookmark' | 'add-folder',
  title: string,
  url: string,
  parentUuid: string,
): Promise<void> {
  if (!data) return;
  const index = indexTree(data.roots);
  let ops: OpDraft[] = [];
  if (mode === 'edit') {
    const changes = {
      ...(title !== node.title ? { title } : {}),
      ...(node.type === 'bookmark' && url !== node.url ? { url } : {}),
    };
    if (Object.keys(changes).length > 0) ops.push({ type: 'update', uuid: node.uuid, ...changes });
    if (parentUuid && parentUuid !== node.parentUuid) {
      const target = index.get(parentUuid)?.node;
      if (target) {
        ops.push({ type: 'move', uuid: node.uuid, parentUuid, sortOrder: endKey(target) });
      }
    }
  } else {
    ops = [
      {
        type: 'create',
        parentUuid: node.uuid,
        nodeType: mode === 'add-folder' ? 'folder' : 'bookmark',
        title,
        ...(mode === 'add-bookmark' ? { url } : {}),
        sortOrder: endKey(node),
      },
    ];
  }
  editing = null;
  if (ops.length === 0) {
    renderBookmarks();
    return;
  }
  if (await send(ops)) say(mode === 'edit' ? `Saved “${title}”.` : `Added “${title}”.`);
}

async function shift(node: BookmarkNode, direction: -1 | 1): Promise<void> {
  if (!data || node.parentUuid === null) return;
  const parent = indexTree(data.roots).get(node.parentUuid)?.node;
  if (!parent) return;
  try {
    const sortOrder = shiftKey(parent, node.uuid, direction);
    if (sortOrder === null) return;
    await send([{ type: 'move', uuid: node.uuid, parentUuid: parent.uuid, sortOrder }]);
  } catch (error) {
    say(`Could not reorder: ${String(error)}`, true);
  }
}

async function remove(node: BookmarkNode): Promise<void> {
  const inside = countDescendants(node);
  const what =
    node.type === 'folder'
      ? `the folder “${node.title}” and the ${inside} item(s) inside it`
      : `“${node.title}”`;
  if (!confirm(`Move ${what} to the trash? It can be restored from the Trash tab.`)) return;
  if (await send([{ type: 'delete', uuid: node.uuid }])) say(`Moved “${node.title}” to trash.`);
}

// -------------------------------------------------------------------- trash

function renderTrash(): void {
  if (!data) return;
  const container = document.getElementById('trash') as HTMLElement;
  const groups = trashGroups(data.trash);
  if (groups.length === 0) {
    container.replaceChildren(el('p', { className: 'empty', textContent: 'The trash is empty.' }));
    return;
  }
  const rows = groups.map(({ item, descendants }) => {
    const restore = el('button', { className: 'small', textContent: 'Restore' });
    restore.addEventListener('click', () => void restoreItem(item));
    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el('div', { textContent: `${item.type === 'folder' ? '📁' : '🔖'} ${item.title}` }),
        ...(item.url ? [el('div', { className: 'path', textContent: item.url })] : []),
      ),
      el('td', { textContent: descendants > 0 ? `+${descendants} inside` : '' }),
      el('td', { textContent: ago(item.deletedAt) }),
      el('td', {}, restore),
    );
  });
  container.replaceChildren(
    el(
      'p',
      { className: 'hint' },
      `Deleted items are kept for ${data.stats.retention.days} days, then purged for good.`,
    ),
    el(
      'div',
      { className: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Item', 'Contents', 'Deleted', ''].map((h) => el('th', { textContent: h })),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

async function restoreItem(item: TrashItem): Promise<void> {
  if (!api) return;
  try {
    const { restored } = await api.restore(item.uuid);
    say(`Restored “${item.title}” (${restored} item${restored === 1 ? '' : 's'}).`);
    void chrome.runtime.sendMessage({ type: 'nodefav:syncNow' }).catch(() => undefined);
  } catch (error) {
    say(String(error), true);
  }
  await refresh();
}

// ------------------------------------------------------------------ devices

function renderDevices(): void {
  if (!data) return;
  const container = document.getElementById('devices') as HTMLElement;
  if (data.devices.length === 0) {
    container.replaceChildren(
      el('p', { className: 'empty', textContent: 'No browser has reported in yet.' }),
    );
    return;
  }
  const newest = data.devices
    .map((device) => device.version)
    .reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), self.version);
  const rows = data.devices.map((device) => {
    const badges: HTMLElement[] = [];
    if (device.deviceId === self.deviceId) {
      badges.push(el('span', { className: 'badge ok', textContent: 'this browser' }));
    }
    if (compareVersions(device.version, newest) < 0) {
      badges.push(el('span', { className: 'badge old', textContent: 'outdated' }));
    }
    return el(
      'tr',
      {},
      el('td', {}, device.name, ' ', ...badges),
      el('td', { textContent: device.version }),
      el('td', { textContent: ago(device.lastSeenAt) }),
      el('td', { className: 'path', textContent: device.deviceId }),
    );
  });
  container.replaceChildren(
    el(
      'div',
      { className: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Name', 'Version', 'Last seen', 'Device ID'].map((h) =>
              el('th', { textContent: h }),
            ),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

// --------------------------------------------------------------------- wiring

for (const tab of document.querySelectorAll<HTMLButtonElement>('nav button[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('nav button[data-tab]')) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      (document.getElementById(`tab-${other.dataset.tab}`) as HTMLElement).hidden = !selected;
    }
  });
}
search.addEventListener('input', () => renderBookmarks());
document.getElementById('refresh')?.addEventListener('click', () => {
  say('');
  void refresh();
});
void load();
