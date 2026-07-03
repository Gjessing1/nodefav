import type { Db } from '../database/db.js';
import { purgeExpired } from './retention.js';
import { runBackup } from './backup.js';

const DAY_MS = 24 * 60 * 60_000;
const TICK_MS = 60 * 60_000;

export interface JobsOptions {
  db: Db;
  /** ':memory:' disables the backup job (tests, ad-hoc runs). */
  dataDir: string;
  retentionDays: number;
  backupKeep: number;
  log: {
    info(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
}

/**
 * Runs the maintenance jobs (retention purge, daily backup) immediately and
 * then hourly. Each job is independently guarded — one failing never blocks
 * the other. Returns a stop function.
 */
export function startJobs(options: JobsOptions): () => void {
  const tick = (): void => {
    const { db, dataDir, retentionDays, backupKeep, log } = options;
    try {
      const cutoff = Date.now() - retentionDays * DAY_MS;
      const purged = purgeExpired(db, cutoff);
      if (purged > 0) log.info({ job: 'retention', purged, retentionDays }, 'purged expired trash');
    } catch (error) {
      log.error({ job: 'retention', error: String(error) }, 'retention job failed');
    }
    if (dataDir === ':memory:') return;
    try {
      const result = runBackup(db, dataDir, backupKeep);
      if (result.created || result.pruned > 0) {
        log.info({ job: 'backup', ...result }, 'database backup written');
      }
    } catch (error) {
      log.error({ job: 'backup', error: String(error) }, 'backup job failed');
    }
  };

  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
