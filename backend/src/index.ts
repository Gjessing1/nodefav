import { buildApp } from './app.js';
import { createDb } from './database/db.js';
import { DEFAULT_BACKUP_KEEP } from './jobs/backup.js';
import { DEFAULT_RETENTION_DAYS } from './jobs/retention.js';
import { startJobs } from './jobs/scheduler.js';

const syncToken = process.env.NODEFAV_SYNC_TOKEN;
if (!syncToken) {
  console.error('NODEFAV_SYNC_TOKEN is required');
  process.exit(1);
}

const dataDir = process.env.NODEFAV_DATA_DIR ?? './data';
const retentionDays = positiveIntEnv('NODEFAV_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
const backupKeep = positiveIntEnv('NODEFAV_BACKUP_KEEP', DEFAULT_BACKUP_KEEP);
const db = createDb(dataDir);

const app = buildApp({ db, syncToken, retentionDays });

startJobs({ db, dataDir, retentionDays, backupKeep, log: app.log });

const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer, got ${raw}`);
    process.exit(1);
  }
  return value;
}
