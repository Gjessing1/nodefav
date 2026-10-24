/**
 * Thin facade over `chrome.bookmarks` — the subset the sync engine uses,
 * expressed browser-neutrally so tests can substitute an in-memory fake and so
 * browser-specific quirks stay in one file.
 */

export interface BookmarkNodeLite {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: BookmarkNodeLite[];
  /** Set (e.g. 'managed') on nodes the user cannot modify — never synced. */
  unmodifiable?: string;
  /**
   * Which permanent root this is ('bookmarks-bar', 'other', 'mobile', 'managed').
   * Locale-independent; Chromium 134+ only.
   */
  folderType?: string;
  /**
   * Set by the facade on the invisible root ('0') in Edge, whose permanent root
   * titles are localized ("Andre favoritter") and so can't be told apart by name.
   */
  browser?: 'edge';
}

export interface ChangeInfo {
  title: string;
  url?: string;
}

export interface MoveInfo {
  parentId: string;
  index: number;
  oldParentId: string;
  oldIndex: number;
}

export interface RemoveInfo {
  parentId: string;
  index: number;
  node: BookmarkNodeLite;
}

export interface BookmarksApi {
  getTree(): Promise<BookmarkNodeLite[]>;
  getChildren(parentId: string): Promise<BookmarkNodeLite[]>;
  /** `undefined` instead of throwing when the node does not exist. */
  get(id: string): Promise<BookmarkNodeLite | undefined>;
  create(details: {
    parentId: string;
    index?: number;
    title: string;
    url?: string;
  }): Promise<BookmarkNodeLite>;
  /** False when the node no longer exists. */
  update(id: string, changes: { title?: string; url?: string }): Promise<boolean>;
  /** False when the node no longer exists. */
  move(id: string, destination: { parentId: string; index?: number }): Promise<boolean>;
  /** Tolerates the node already being gone. */
  removeTree(id: string): Promise<void>;

  onCreated(listener: (id: string, node: BookmarkNodeLite) => void): void;
  onChanged(listener: (id: string, changeInfo: ChangeInfo) => void): void;
  onMoved(listener: (id: string, moveInfo: MoveInfo) => void): void;
  onRemoved(listener: (id: string, removeInfo: RemoveInfo) => void): void;
}

const IS_EDGE = typeof navigator !== 'undefined' && /\bEdg\//.test(navigator.userAgent);

export function chromeBookmarksApi(): BookmarksApi {
  return {
    getTree: async () => {
      const tree: BookmarkNodeLite[] = await chrome.bookmarks.getTree();
      if (IS_EDGE && tree[0]) tree[0].browser = 'edge';
      return tree;
    },
    getChildren: (parentId) => chrome.bookmarks.getChildren(parentId),
    get: async (id) => {
      try {
        const [node] = await chrome.bookmarks.get(id);
        return node;
      } catch {
        return undefined;
      }
    },
    create: (details) => chrome.bookmarks.create(details),
    update: async (id, changes) => {
      try {
        await chrome.bookmarks.update(id, changes);
        return true;
      } catch {
        return false;
      }
    },
    move: async (id, destination) => {
      try {
        await chrome.bookmarks.move(id, destination);
        return true;
      } catch {
        return false;
      }
    },
    removeTree: async (id) => {
      // removeTree only accepts folders; fall back for leaf bookmarks. A node
      // that is already gone is a success for our purposes.
      try {
        await chrome.bookmarks.removeTree(id);
      } catch {
        try {
          await chrome.bookmarks.remove(id);
        } catch {
          /* already gone */
        }
      }
    },
    onCreated: (listener) => chrome.bookmarks.onCreated.addListener(listener),
    onChanged: (listener) => chrome.bookmarks.onChanged.addListener(listener),
    onMoved: (listener) => chrome.bookmarks.onMoved.addListener(listener),
    onRemoved: (listener) => chrome.bookmarks.onRemoved.addListener(listener),
  };
}
