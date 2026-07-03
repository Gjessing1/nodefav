import { count, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { GetStatsResponse } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarks, operations } from '../database/schema.js';

/** Basic operational metrics for monitoring — cheap enough to poll. */
export function collectStats(
  db: Db,
  retentionDays: number,
  serverVersion: number,
): GetStatsResponse {
  const live = db.select({ n: count() }).from(bookmarks).where(isNull(bookmarks.deletedAt)).get();
  const deleted = db
    .select({ n: count() })
    .from(bookmarks)
    .where(isNotNull(bookmarks.deletedAt))
    .get();
  const ops = db
    .select({ n: count(), last: max(operations.appliedAt) })
    .from(operations)
    .get();
  const size = db.get<{ size: number }>(
    sql`select page_count * page_size as size from pragma_page_count(), pragma_page_size()`,
  );

  return {
    bookmarks: { live: live?.n ?? 0, deleted: deleted?.n ?? 0 },
    operations: { total: ops?.n ?? 0, lastAppliedAt: ops?.last ?? null },
    database: { sizeBytes: size?.size ?? 0 },
    retention: { days: retentionDays },
    serverVersion,
  };
}
