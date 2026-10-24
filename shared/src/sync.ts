/** Node kind in the bookmark tree. */
export type BookmarkType = 'bookmark' | 'folder';

/**
 * Fields common to every synchronization operation. Operations are
 * client-generated, uploaded in batches and idempotent via `opId`.
 */
export interface SyncOpBase {
  /** Client-generated unique id — the idempotency key for uploads. */
  opId: string;
  /** Stable id of the device/install that produced the op. */
  deviceId: string;
  /** Client wall-clock in ms since epoch — input to LWW conflict resolution. */
  timestamp: number;
}

export interface CreateOp extends SyncOpBase {
  type: 'create';
  /** Parent folder uuid, or null for a root-level node. */
  parentUuid: string | null;
  nodeType: BookmarkType;
  title: string;
  /** Required for bookmarks, absent for folders. */
  url?: string;
  /** Fractional ordering key within the parent (provisional scheme, Phase 4). */
  sortOrder: string;
}

export interface UpdateOp extends SyncOpBase {
  type: 'update';
  uuid: string;
  title?: string;
  url?: string;
}

export interface MoveOp extends SyncOpBase {
  type: 'move';
  uuid: string;
  parentUuid: string | null;
  sortOrder: string;
}

export interface DeleteOp extends SyncOpBase {
  type: 'delete';
  uuid: string;
}

export type SyncOp = CreateOp | UpdateOp | MoveOp | DeleteOp;

/**
 * Per-op outcome of an upload.
 * - `applied`: mutated state and was appended to the op log.
 * - `duplicate`: this opId was applied earlier; original seq/uuid returned.
 * - `stale`: lost LWW against a newer already-applied op; not logged.
 * - `rejected`: invalid (unknown uuid, bad parent, cycle, …); not logged.
 */
export type OpStatus = 'applied' | 'duplicate' | 'stale' | 'rejected';

export interface OpResult {
  opId: string;
  status: OpStatus;
  /** Target bookmark uuid (server-assigned for creates). */
  uuid?: string;
  /** Server sequence number, for applied ops and duplicates of applied ops. */
  seq?: number;
  /** Human-readable reason, for rejected ops. */
  error?: string;
}

export interface PostOpsRequest {
  ops: SyncOp[];
}

export interface PostOpsResponse {
  results: OpResult[];
  /** Monotonic server version — the seq of the newest op in the log. */
  serverVersion: number;
}

/**
 * An applied operation as served by `GET /api/ops`. Normalized: creates carry
 * the server-assigned `uuid`, so replaying the log from 0 reconstructs the tree.
 */
export type RemoteOp = SyncOp & { seq: number; uuid: string };

export interface GetOpsResponse {
  ops: RemoteOp[];
  serverVersion: number;
}

export interface BookmarkNode {
  uuid: string;
  parentUuid: string | null;
  type: BookmarkType;
  title: string;
  url: string | null;
  sortOrder: string;
  createdAt: number;
  updatedAt: number;
  /** Server seq of the last op applied to this node. */
  version: number;
  /** Present (possibly empty) for folders, absent for bookmarks. */
  children?: BookmarkNode[];
}

export interface GetBookmarksResponse {
  roots: BookmarkNode[];
  serverVersion: number;
}

/** A soft-deleted node awaiting purge, as served by `GET /api/trash`. */
export interface TrashItem {
  uuid: string;
  /** Parent at deletion time; may itself be deleted or already purged. */
  parentUuid: string | null;
  type: BookmarkType;
  title: string;
  url: string | null;
  sortOrder: string;
  deletedAt: number;
}

export interface GetTrashResponse {
  items: TrashItem[];
  serverVersion: number;
}

export interface PostRestoreRequest {
  uuid: string;
}

/**
 * Restore brings back the node plus everything soft-deleted by the same
 * cascade, reparenting to the nearest live ancestor (root as last resort).
 * It propagates to clients as synthetic create ops appended to the log.
 */
export interface PostRestoreResponse {
  /** Number of nodes brought back (the node itself + cascaded descendants). */
  restored: number;
  serverVersion: number;
}

/** Reconciliation input, served by `GET /api/checksum` (see shared/checksum.ts). */
export interface GetChecksumResponse {
  /** treeChecksum() over every live non-root node. */
  checksum: string;
  /** Number of live non-root nodes covered by the checksum. */
  count: number;
  /** Uuids of live root-level nodes — excluded from the checksum on both sides. */
  rootUuids: string[];
  serverVersion: number;
}

/**
 * Cloud-side enrichment health of a bookmark's URL (Phase 6 background job):
 * - `ok`: last fetch succeeded.
 * - `failing`: recent failures, below the dead-link threshold.
 * - `dead`: failed the threshold number of consecutive checks.
 * - `skipped`: not fetchable (non-http scheme); never rechecked.
 */
export type LinkHealth = 'ok' | 'failing' | 'dead' | 'skipped';

/** Enrichment record for one bookmark, served by `GET /api/meta`. */
export interface MetaItem {
  uuid: string;
  /** The bookmark's own title/url, for readability of the listing. */
  title: string;
  url: string | null;
  health: LinkHealth;
  httpStatus: number | null;
  pageTitle: string | null;
  faviconUrl: string | null;
  consecutiveFailures: number;
  checkedAt: number;
  okAt: number | null;
}

export interface GetMetaResponse {
  items: MetaItem[];
  serverVersion: number;
}

/** Basic operational metrics, served by `GET /api/stats`. */
export interface GetStatsResponse {
  bookmarks: { live: number; deleted: number };
  operations: { total: number; lastAppliedAt: number | null };
  database: { sizeBytes: number };
  retention: { days: number };
  /** Currently connected `GET /api/events` SSE clients. */
  realtime: { eventStreams: number };
  /** Background enrichment progress: checked rows, dead links, unchecked live bookmarks. */
  enrichment: { checked: number; dead: number; pending: number };
  serverVersion: number;
}

/**
 * A browser install as it last reported itself (`PUT /api/devices/:deviceId`).
 * Purely informational — sync never depends on it — but it shows which
 * browser is which and which ones still run an outdated extension.
 */
export interface DeviceInfo {
  /** The same id the device stamps on its ops. */
  deviceId: string;
  /** User-chosen label, e.g. "Vivaldi – laptop". */
  name: string;
  /** Extension manifest version. */
  version: string;
  /** Server wall-clock ms of the last report. */
  lastSeenAt: number;
}

export interface PutDeviceRequest {
  name: string;
  version: string;
}

export interface GetDevicesResponse {
  /** Most recently seen first. */
  devices: DeviceInfo[];
}
