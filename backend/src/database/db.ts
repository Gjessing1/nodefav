import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

// Resolves to backend/drizzle both from src/ (dev, tests) and dist/ (runtime).
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Opens (creating if needed) the SQLite database and runs pending migrations.
 * Pass `:memory:` as `dataDir` for tests.
 */
export function createDb(dataDir: string) {
  let sqlite: Database.Database;
  if (dataDir === ':memory:') {
    sqlite = new Database(':memory:');
  } else {
    mkdirSync(dataDir, { recursive: true });
    sqlite = new Database(join(dataDir, 'nodefav.sqlite'));
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
