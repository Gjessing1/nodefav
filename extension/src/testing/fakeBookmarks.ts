import type {
  BookmarkNodeLite,
  BookmarksApi,
  ChangeInfo,
  MoveInfo,
  RemoveInfo,
} from '../chrome/bookmarksApi.js';

interface FakeNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  childIds: string[];
  unmodifiable?: string;
}

type PendingEvent =
  | { type: 'created'; id: string; node: BookmarkNodeLite }
  | { type: 'changed'; id: string; info: ChangeInfo }
  | { type: 'moved'; id: string; info: MoveInfo }
  | { type: 'removed'; id: string; info: RemoveInfo };

/**
 * In-memory simulation of the Chromium bookmark tree with event emission.
 * Two service-worker-death levers for torture tests:
 * - `suspendEvents()` holds emitted events instead of delivering them, so a
 *   "new worker" can receive them later via `resumeEvents()`;
 * - `resetListeners()` drops all registered listeners, as a real worker death
 *   would.
 */
export class FakeBookmarks implements BookmarksApi {
  private nodes = new Map<string, FakeNode>();
  private nextId = 100;
  private pending: PendingEvent[] = [];
  private suspended = false;
  private listeners = {
    created: [] as Array<(id: string, node: BookmarkNodeLite) => void>,
    changed: [] as Array<(id: string, info: ChangeInfo) => void>,
    moved: [] as Array<(id: string, info: MoveInfo) => void>,
    removed: [] as Array<(id: string, info: RemoveInfo) => void>,
  };

  constructor(
    rootTitles: string[] = ['Bookmarks bar', 'Other bookmarks'],
    /** Test lever: `browser` can be flipped to simulate an extension update. */
    readonly options: { browser?: 'edge' } = {},
  ) {
    this.nodes.set('0', { id: '0', title: '', childIds: [] });
    rootTitles.forEach((title, i) => {
      const id = String(i + 1);
      this.nodes.set(id, { id, parentId: '0', title, childIds: [] });
      (this.nodes.get('0') as FakeNode).childIds.push(id);
    });
  }

  // --- test levers -----------------------------------------------------------

  suspendEvents(): void {
    this.suspended = true;
  }
  resumeEvents(): void {
    this.suspended = false;
    this.deliverPending();
  }
  resetListeners(): void {
    this.listeners = { created: [], changed: [], moved: [], removed: [] };
  }

  /** Root-level view of the tree as plain data, for equality assertions. */
  snapshot(): Array<{ title: string; url?: string; children?: unknown[] }> {
    const toPlain = (id: string): { title: string; url?: string; children?: unknown[] } => {
      const node = this.nodes.get(id) as FakeNode;
      return {
        title: node.title,
        ...(node.url !== undefined ? { url: node.url } : {}),
        ...(node.url === undefined ? { children: node.childIds.map(toPlain) } : {}),
      };
    };
    return (this.nodes.get('0') as FakeNode).childIds.map(toPlain);
  }

  nodeCount(): number {
    return this.nodes.size - 1; // minus the invisible root
  }

  // --- BookmarksApi ----------------------------------------------------------

  getTree(): Promise<BookmarkNodeLite[]> {
    const root = this.toLite('0', true);
    if (this.options.browser) root.browser = this.options.browser;
    return Promise.resolve([root]);
  }
  getChildren(parentId: string): Promise<BookmarkNodeLite[]> {
    const parent = this.nodes.get(parentId);
    if (!parent) return Promise.reject(new Error(`no node ${parentId}`));
    return Promise.resolve(parent.childIds.map((id) => this.toLite(id, false)));
  }
  get(id: string): Promise<BookmarkNodeLite | undefined> {
    return Promise.resolve(this.nodes.has(id) ? this.toLite(id, false) : undefined);
  }

  create(details: {
    parentId: string;
    index?: number;
    title: string;
    url?: string;
  }): Promise<BookmarkNodeLite> {
    const parent = this.nodes.get(details.parentId);
    if (!parent || parent.url !== undefined) {
      return Promise.reject(new Error(`invalid parent ${details.parentId}`));
    }
    const id = String(this.nextId++);
    const node: FakeNode = {
      id,
      parentId: details.parentId,
      title: details.title,
      ...(details.url !== undefined ? { url: details.url } : {}),
      childIds: [],
    };
    this.nodes.set(id, node);
    const index = Math.min(details.index ?? parent.childIds.length, parent.childIds.length);
    parent.childIds.splice(index, 0, id);
    const lite = this.toLite(id, false);
    this.emit({ type: 'created', id, node: lite });
    return Promise.resolve(lite);
  }

  update(id: string, changes: { title?: string; url?: string }): Promise<boolean> {
    const node = this.nodes.get(id);
    if (!node) return Promise.resolve(false);
    // Like Chromium: title and URL are separate model changes, each firing
    // onChanged with the node's state at that moment (title first).
    const emitChanged = (): void =>
      this.emit({
        type: 'changed',
        id,
        info: { title: node.title, ...(node.url !== undefined ? { url: node.url } : {}) },
      });
    if (changes.title !== undefined) {
      node.title = changes.title;
      emitChanged();
    }
    if (changes.url !== undefined && node.url !== undefined) {
      node.url = changes.url;
      emitChanged();
    }
    return Promise.resolve(true);
  }

  move(id: string, destination: { parentId: string; index?: number }): Promise<boolean> {
    const node = this.nodes.get(id);
    const newParent = this.nodes.get(destination.parentId);
    if (!node || !newParent || node.parentId === undefined) return Promise.resolve(false);
    const oldParent = this.nodes.get(node.parentId) as FakeNode;
    const oldIndex = oldParent.childIds.indexOf(id);
    oldParent.childIds.splice(oldIndex, 1);
    const index = Math.min(
      destination.index ?? newParent.childIds.length,
      newParent.childIds.length,
    );
    newParent.childIds.splice(index, 0, id);
    node.parentId = newParent.id;
    this.emit({
      type: 'moved',
      id,
      info: { parentId: newParent.id, index, oldParentId: oldParent.id, oldIndex },
    });
    return Promise.resolve(true);
  }

  removeTree(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node || node.parentId === undefined) return Promise.resolve();
    const parent = this.nodes.get(node.parentId) as FakeNode;
    const index = parent.childIds.indexOf(id);
    const lite = this.toLite(id, false);
    const drop = (nodeId: string): void => {
      const n = this.nodes.get(nodeId);
      if (!n) return;
      for (const childId of n.childIds) drop(childId);
      this.nodes.delete(nodeId);
    };
    drop(id);
    parent.childIds.splice(index, 1);
    this.emit({ type: 'removed', id, info: { parentId: parent.id, index, node: lite } });
    return Promise.resolve();
  }

  onCreated(listener: (id: string, node: BookmarkNodeLite) => void): void {
    this.listeners.created.push(listener);
  }
  onChanged(listener: (id: string, info: ChangeInfo) => void): void {
    this.listeners.changed.push(listener);
  }
  onMoved(listener: (id: string, info: MoveInfo) => void): void {
    this.listeners.moved.push(listener);
  }
  onRemoved(listener: (id: string, info: RemoveInfo) => void): void {
    this.listeners.removed.push(listener);
  }

  // --- internals --------------------------------------------------------------

  private toLite(id: string, deep: boolean): BookmarkNodeLite {
    const node = this.nodes.get(id) as FakeNode;
    const parent = node.parentId !== undefined ? this.nodes.get(node.parentId) : undefined;
    return {
      id: node.id,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(parent ? { index: parent.childIds.indexOf(id) } : {}),
      title: node.title,
      ...(node.url !== undefined ? { url: node.url } : {}),
      ...(node.unmodifiable !== undefined ? { unmodifiable: node.unmodifiable } : {}),
      ...(node.url === undefined && deep
        ? { children: node.childIds.map((childId) => this.toLite(childId, true)) }
        : {}),
    };
  }

  private emit(event: PendingEvent): void {
    this.pending.push(event);
    if (!this.suspended) this.deliverPending();
  }

  private deliverPending(): void {
    while (this.pending.length > 0) {
      const event = this.pending.shift() as PendingEvent;
      switch (event.type) {
        case 'created':
          for (const l of [...this.listeners.created]) l(event.id, event.node);
          break;
        case 'changed':
          for (const l of [...this.listeners.changed]) l(event.id, event.info);
          break;
        case 'moved':
          for (const l of [...this.listeners.moved]) l(event.id, event.info);
          break;
        case 'removed':
          for (const l of [...this.listeners.removed]) l(event.id, event.info);
          break;
      }
    }
  }
}
