import type { BookmarkType } from '@nodefav/shared';

/**
 * A captured browser edit, queued durably until uploaded. Queue items reference
 * nodes by browser id; translation to cloud uuids happens at upload time, once
 * the uuids exist (a node's create may still be in flight when its children are
 * captured).
 */
export interface QueuedOp {
  /** Auto-assigned queue position — uploads happen in qid order. */
  qid: number;
  /** Client-generated idempotency key, becomes SyncOp.opId. */
  opId: string;
  timestamp: number;
  kind: 'create' | 'update' | 'move' | 'delete';
  browserId: string;
  /** create + move */
  parentBrowserId?: string;
  /** create */
  nodeType?: BookmarkType;
  /** create + update */
  title?: string;
  /** create + update */
  url?: string;
  /** create + move */
  sortOrder?: string;
}

export type QueuedOpInput = Omit<QueuedOp, 'qid'>;

/**
 * browserId → cloud uuid bridge, plus the local shadow of parent/ordering that
 * fractional-key computation needs. `uuid` is absent while the node's create op
 * is still queued (pending mapping).
 */
export interface Mapping {
  browserId: string;
  uuid?: string;
  parentBrowserId: string;
  sortOrder: string;
}

export type EchoAction = 'create' | 'update' | 'move' | 'delete';

/**
 * A remote-applied change the browser is expected to echo back as a bookmark
 * event. Persisted BEFORE the native tree is touched — a service worker can die
 * between mutating the tree and receiving the echoed event, and the echo then
 * arrives in a fresh worker.
 */
export interface EchoRecord {
  id: number;
  action: EchoAction;
  /** Cloud uuid of the affected node. */
  uuid: string;
  /** Known in advance for update/move/delete; unknowable for create. */
  browserId?: string;
  /** create + move */
  parentBrowserId?: string;
  /** create + update — only the fields the remote op actually changed. */
  title?: string;
  /** create + update */
  url?: string;
  /** create + move — lets echo consumption repair the mapping shadow. */
  sortOrder?: string;
  createdAt: number;
}

export type EchoInput = Omit<EchoRecord, 'id' | 'createdAt'>;

/** What an incoming browser event looks like to the echo matcher. */
export interface EchoProbe {
  action: EchoAction;
  browserId?: string;
  parentBrowserId?: string;
  title?: string;
  url?: string;
}
