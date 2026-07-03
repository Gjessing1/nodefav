import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { CreateOp, TrashItem } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarks, operations } from '../database/schema.js';
import type { BookmarkRow } from '../database/schema.js';

/** Every soft-deleted row still inside the retention window, newest first. */
export function listTrash(db: Db): TrashItem[] {
  return db
    .select()
    .from(bookmarks)
    .where(isNotNull(bookmarks.deletedAt))
    .orderBy(desc(bookmarks.deletedAt), bookmarks.uuid)
    .all()
    .map((row) => ({
      uuid: row.uuid,
      parentUuid: row.parentUuid,
      type: row.type,
      title: row.title,
      url: row.url,
      sortOrder: row.sortOrder,
      deletedAt: row.deletedAt as number,
    }));
}

export type RestoreOutcome = { restored: number } | { error: 'not-found' | 'not-deleted' };

/**
 * Restores a soft-deleted node together with the descendants its delete
 * cascaded to (recognizable by the shared `deletedAt` stamp; independently
 * deleted descendants stay in the trash). The node reparents to its nearest
 * live ancestor — root level if the whole chain is gone or purged.
 *
 * Propagation reuses the create machinery: each restored row is appended to
 * the log as a synthetic create op carrying its uuid, so every client
 * re-materializes it through the ordinary pull path and a fresh replay from
 * seq 0 still converges (create → delete → create).
 */
export function restoreSubtree(db: Db, uuid: string, now: number): RestoreOutcome {
  return db.transaction((tx) => {
    const root = tx.select().from(bookmarks).where(eq(bookmarks.uuid, uuid)).get();
    if (!root) return { error: 'not-found' };
    if (root.deletedAt === null) return { error: 'not-deleted' };

    // Parents-first cascade set: descendants sharing the delete stamp.
    const toRestore: BookmarkRow[] = [root];
    let frontier = [root.uuid];
    while (frontier.length > 0) {
      const children = tx
        .select()
        .from(bookmarks)
        .where(
          and(inArray(bookmarks.parentUuid, frontier), eq(bookmarks.deletedAt, root.deletedAt)),
        )
        .all();
      toRestore.push(...children);
      frontier = children.map((row) => row.uuid);
    }

    const parentUuid = nearestLiveAncestor(tx, root.parentUuid);
    for (const row of toRestore) {
      const target = row.uuid === root.uuid ? parentUuid : row.parentUuid;
      const payload: CreateOp & { uuid: string } = {
        opId: randomUUID(),
        deviceId: 'server:restore',
        timestamp: now,
        type: 'create',
        parentUuid: target,
        nodeType: row.type,
        title: row.title,
        ...(row.type === 'bookmark' ? { url: row.url ?? '' } : {}),
        sortOrder: row.sortOrder,
        uuid: row.uuid,
      };
      const inserted = tx
        .insert(operations)
        .values({
          clientOpId: payload.opId,
          deviceId: payload.deviceId,
          type: 'create',
          bookmarkUuid: row.uuid,
          payload: JSON.stringify(payload),
          clientTimestamp: now,
          appliedAt: Date.now(),
        })
        .returning({ seq: operations.seq })
        .get();
      tx.update(bookmarks)
        .set({ deletedAt: null, parentUuid: target, updatedAt: now, version: inserted.seq })
        .where(eq(bookmarks.uuid, row.uuid))
        .run();
    }
    return { restored: toRestore.length };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Walks up until a live folder; a purged (missing) link ends the walk at root. */
function nearestLiveAncestor(tx: Tx, start: string | null): string | null {
  let cursor = start;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row = tx.select().from(bookmarks).where(eq(bookmarks.uuid, cursor)).get();
    if (!row) return null;
    if (row.deletedAt === null && row.type === 'folder') return row.uuid;
    cursor = row.parentUuid;
  }
  return null;
}
