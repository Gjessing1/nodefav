import { isNull } from 'drizzle-orm';
import { treeChecksum } from '@nodefav/shared';
import type { ChecksumEntry, GetChecksumResponse } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarks } from '../database/schema.js';

/** Reconciliation snapshot: checksum over live non-root rows + the root uuids. */
export function computeChecksum(db: Db, serverVersion: number): GetChecksumResponse {
  const rows = db.select().from(bookmarks).where(isNull(bookmarks.deletedAt)).all();
  const entries: ChecksumEntry[] = [];
  const rootUuids: string[] = [];
  for (const row of rows) {
    if (row.parentUuid === null) {
      rootUuids.push(row.uuid);
    } else {
      entries.push({
        uuid: row.uuid,
        parentUuid: row.parentUuid,
        type: row.type,
        title: row.title,
        url: row.url,
        sortOrder: row.sortOrder,
      });
    }
  }
  rootUuids.sort();
  return { checksum: treeChecksum(entries), count: entries.length, rootUuids, serverVersion };
}
