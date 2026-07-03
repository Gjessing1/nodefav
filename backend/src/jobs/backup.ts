import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../database/db.js';

export const DEFAULT_BACKUP_KEEP = 7;

const BACKUP_FILE = /^nodefav-\d{4}-\d{2}-\d{2}\.sqlite$/;

export interface BackupResult {
  /** Absolute path of today's backup file. */
  path: string;
  /** False when today's backup already existed and nothing was written. */
  created: boolean;
  /** Old backup files removed to satisfy `keep`. */
  pruned: number;
}

/**
 * Writes an online snapshot of the database to `<dataDir>/backups/` via
 * `VACUUM INTO` (consistent even under WAL, no downtime), one file per day,
 * then prunes to the newest `keep` files. Idempotent within a day.
 */
export function runBackup(db: Db, dataDir: string, keep: number, now = Date.now()): BackupResult {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });

  const day = new Date(now).toISOString().slice(0, 10);
  const path = join(dir, `nodefav-${day}.sqlite`);
  const created = !existsSync(path);
  if (created) db.run(sql`VACUUM INTO ${path}`);

  const stale = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort()
    .reverse()
    .slice(Math.max(keep, 1));
  for (const name of stale) unlinkSync(join(dir, name));

  return { path, created, pruned: stale.length };
}
