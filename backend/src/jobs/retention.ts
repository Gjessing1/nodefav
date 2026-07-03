import { and, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../database/db.js';
import { bookmarks } from '../database/schema.js';

export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Permanently purges bookmark rows soft-deleted at or before `cutoff`. Only
 * the materialized rows go — the op log stays append-only, so replaying it
 * still converges (clients simply create-then-delete the purged nodes).
 * Returns the number of rows purged.
 */
export function purgeExpired(db: Db, cutoff: number): number {
  const result = db
    .delete(bookmarks)
    .where(and(isNotNull(bookmarks.deletedAt), lte(bookmarks.deletedAt, cutoff)))
    .run();
  return result.changes;
}
