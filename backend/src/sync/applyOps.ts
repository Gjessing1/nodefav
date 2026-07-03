import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import type { OpResult, SyncOp } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarks, operations } from '../database/schema.js';

/**
 * LWW is resolved per field group, so a move and an update never conflict with
 * each other: updates (title/url) compete with creates + updates, moves
 * (parent/order) with creates + moves. An incoming op loses (`stale`) only to a
 * strictly newer already-applied op in its group; ties apply in arrival order.
 * (Provisional semantics — validated in Phase 4.)
 */
const LWW_GROUPS = {
  update: ['create', 'update'],
  move: ['create', 'move'],
} as const;

export function currentServerVersion(db: Db): number {
  const row = db
    .select({ v: max(operations.seq) })
    .from(operations)
    .get();
  return row?.v ?? 0;
}

/**
 * Applies a batch of client ops in one transaction. Every op yields a result;
 * rejected/stale ops don't abort the batch. Only applied ops enter the log.
 */
export function applyOps(db: Db, ops: SyncOp[]): { results: OpResult[]; serverVersion: number } {
  const results = db.transaction((tx) => ops.map((op) => applyOne(tx, op)));
  return { results, serverVersion: currentServerVersion(db) };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function applyOne(tx: Tx, op: SyncOp): OpResult {
  const existing = tx
    .select({ seq: operations.seq, bookmarkUuid: operations.bookmarkUuid })
    .from(operations)
    .where(eq(operations.clientOpId, op.opId))
    .get();
  if (existing) {
    return { opId: op.opId, status: 'duplicate', uuid: existing.bookmarkUuid, seq: existing.seq };
  }

  switch (op.type) {
    case 'create':
      return applyCreate(tx, op);
    case 'update':
      return applyUpdate(tx, op);
    case 'move':
      return applyMove(tx, op);
    case 'delete':
      return applyDelete(tx, op);
  }
}

function applyCreate(tx: Tx, op: SyncOp & { type: 'create' }): OpResult {
  const parentError = validateParent(tx, op.parentUuid);
  if (parentError) return { opId: op.opId, status: 'rejected', error: parentError };

  // Uuids are server-assigned; the HTTP layer rejects client-supplied ones.
  // Replaying logged ops (RemoteOp) goes through here too and keeps its uuid.
  const presetUuid = (op as { uuid?: unknown }).uuid;
  const uuid = typeof presetUuid === 'string' ? presetUuid : randomUUID();
  tx.insert(bookmarks)
    .values({
      uuid,
      parentUuid: op.parentUuid,
      type: op.nodeType,
      title: op.title,
      url: op.nodeType === 'bookmark' ? (op.url ?? null) : null,
      sortOrder: op.sortOrder,
      createdAt: op.timestamp,
      updatedAt: op.timestamp,
      deletedAt: null,
      version: 0,
    })
    .run();

  const seq = logOp(tx, op, uuid);
  tx.update(bookmarks).set({ version: seq }).where(eq(bookmarks.uuid, uuid)).run();
  return { opId: op.opId, status: 'applied', uuid, seq };
}

function applyUpdate(tx: Tx, op: SyncOp & { type: 'update' }): OpResult {
  const row = getBookmark(tx, op.uuid);
  if (!row) return { opId: op.opId, status: 'rejected', error: `unknown bookmark ${op.uuid}` };
  if (isStale(tx, op.uuid, 'update', op.timestamp)) {
    return { opId: op.opId, status: 'stale', uuid: op.uuid };
  }

  const seq = logOp(tx, op, op.uuid);
  tx.update(bookmarks)
    .set({
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.url !== undefined && row.type === 'bookmark' ? { url: op.url } : {}),
      updatedAt: Math.max(row.updatedAt, op.timestamp),
      version: seq,
    })
    .where(eq(bookmarks.uuid, op.uuid))
    .run();
  return { opId: op.opId, status: 'applied', uuid: op.uuid, seq };
}

function applyMove(tx: Tx, op: SyncOp & { type: 'move' }): OpResult {
  const row = getBookmark(tx, op.uuid);
  if (!row) return { opId: op.opId, status: 'rejected', error: `unknown bookmark ${op.uuid}` };

  const parentError = validateParent(tx, op.parentUuid);
  if (parentError) return { opId: op.opId, status: 'rejected', error: parentError };
  if (op.parentUuid !== null && createsCycle(tx, op.uuid, op.parentUuid)) {
    return { opId: op.opId, status: 'rejected', error: 'move would create a cycle' };
  }
  if (isStale(tx, op.uuid, 'move', op.timestamp)) {
    return { opId: op.opId, status: 'stale', uuid: op.uuid };
  }

  const seq = logOp(tx, op, op.uuid);
  tx.update(bookmarks)
    .set({
      parentUuid: op.parentUuid,
      sortOrder: op.sortOrder,
      updatedAt: Math.max(row.updatedAt, op.timestamp),
      version: seq,
    })
    .where(eq(bookmarks.uuid, op.uuid))
    .run();
  return { opId: op.opId, status: 'applied', uuid: op.uuid, seq };
}

function applyDelete(tx: Tx, op: SyncOp & { type: 'delete' }): OpResult {
  const row = getBookmark(tx, op.uuid);
  if (!row) return { opId: op.opId, status: 'rejected', error: `unknown bookmark ${op.uuid}` };

  const seq = logOp(tx, op, op.uuid);
  // Soft delete cascades to live descendants; replaying the log in seq order
  // reproduces the same descendant set, so replay stays deterministic.
  const toDelete = [op.uuid, ...liveDescendants(tx, op.uuid)];
  tx.update(bookmarks)
    .set({ deletedAt: op.timestamp, version: seq })
    .where(and(inArray(bookmarks.uuid, toDelete), isNull(bookmarks.deletedAt)))
    .run();
  return { opId: op.opId, status: 'applied', uuid: op.uuid, seq };
}

/** Appends the op to the log and returns its server seq. */
function logOp(tx: Tx, op: SyncOp, uuid: string): number {
  const payload: SyncOp & { uuid: string } = { ...op, uuid };
  const inserted = tx
    .insert(operations)
    .values({
      clientOpId: op.opId,
      deviceId: op.deviceId,
      type: op.type,
      bookmarkUuid: uuid,
      payload: JSON.stringify(payload),
      clientTimestamp: op.timestamp,
      appliedAt: Date.now(),
    })
    .returning({ seq: operations.seq })
    .get();
  return inserted.seq;
}

/** True if an already-applied op in the same LWW group is strictly newer. */
function isStale(tx: Tx, uuid: string, group: keyof typeof LWW_GROUPS, timestamp: number): boolean {
  const row = tx
    .select({ t: max(operations.clientTimestamp) })
    .from(operations)
    .where(and(eq(operations.bookmarkUuid, uuid), inArray(operations.type, [...LWW_GROUPS[group]])))
    .get();
  return row?.t != null && row.t > timestamp;
}

function getBookmark(tx: Tx, uuid: string) {
  return tx.select().from(bookmarks).where(eq(bookmarks.uuid, uuid)).get();
}

/** null parent (root) is always valid; otherwise it must be a live folder. */
function validateParent(tx: Tx, parentUuid: string | null): string | null {
  if (parentUuid === null) return null;
  const parent = getBookmark(tx, parentUuid);
  if (!parent) return `unknown parent ${parentUuid}`;
  if (parent.type !== 'folder') return `parent ${parentUuid} is not a folder`;
  if (parent.deletedAt !== null) return `parent ${parentUuid} is deleted`;
  return null;
}

/** True if `newParent` is `uuid` itself or one of its descendants. */
function createsCycle(tx: Tx, uuid: string, newParent: string): boolean {
  let cursor: string | null = newParent;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === uuid) return true;
    if (seen.has(cursor)) return true; // corrupt ancestry — refuse rather than loop
    seen.add(cursor);
    const row = tx
      .select({ parentUuid: bookmarks.parentUuid })
      .from(bookmarks)
      .where(eq(bookmarks.uuid, cursor))
      .get();
    cursor = row?.parentUuid ?? null;
  }
  return false;
}

/** Uuids of all not-yet-deleted descendants of `uuid` (breadth-first). */
function liveDescendants(tx: Tx, uuid: string): string[] {
  const result: string[] = [];
  let frontier = [uuid];
  while (frontier.length > 0) {
    const children = tx
      .select({ uuid: bookmarks.uuid })
      .from(bookmarks)
      .where(and(inArray(bookmarks.parentUuid, frontier), isNull(bookmarks.deletedAt)))
      .all()
      .map((r) => r.uuid);
    result.push(...children);
    frontier = children;
  }
  return result;
}
