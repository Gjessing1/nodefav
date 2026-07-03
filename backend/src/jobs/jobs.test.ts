import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { isNull } from 'drizzle-orm';
import type { CreateOp, DeleteOp } from '@nodefav/shared';
import { createDb } from '../database/db.js';
import { bookmarks, operations } from '../database/schema.js';
import { applyOps } from '../sync/applyOps.js';
import { runBackup } from './backup.js';
import { purgeExpired } from './retention.js';

let opCounter = 0;
function createBookmark(title: string, timestamp: number): CreateOp {
  return {
    opId: `op-${++opCounter}`,
    deviceId: 'device-test',
    timestamp,
    type: 'create',
    parentUuid: null,
    nodeType: 'bookmark',
    title,
    url: `https://example.com/${title}`,
    sortOrder: 'a0',
  };
}

function deleteOp(uuid: string, timestamp: number): DeleteOp {
  return { opId: `op-${++opCounter}`, deviceId: 'device-test', timestamp, type: 'delete', uuid };
}

test('purgeExpired removes only soft-deleted rows past the cutoff', () => {
  const db = createDb(':memory:');
  const { results } = applyOps(db, [
    createBookmark('keep-live', 1_000),
    createBookmark('keep-recent-trash', 1_000),
    createBookmark('purge-old-trash', 1_000),
  ]);
  const [, recent, old] = results.map((r) => r.uuid as string);
  applyOps(db, [deleteOp(recent as string, 9_000), deleteOp(old as string, 2_000)]);

  const purged = purgeExpired(db, 5_000);

  assert.equal(purged, 1);
  const remaining = db.select({ uuid: bookmarks.uuid }).from(bookmarks).all();
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.some((row) => row.uuid === old));
  const live = db.select().from(bookmarks).where(isNull(bookmarks.deletedAt)).all();
  assert.equal(live.length, 1);
});

test('purgeExpired keeps the op log intact', () => {
  const db = createDb(':memory:');
  const { results } = applyOps(db, [createBookmark('doomed', 1_000)]);
  applyOps(db, [deleteOp(results[0]?.uuid as string, 2_000)]);

  assert.equal(purgeExpired(db, 10_000), 1);

  const ops = db.select().from(operations).all();
  assert.equal(ops.length, 2); // create + delete both survive the purge
  assert.equal(purgeExpired(db, 10_000), 0); // idempotent
});

test('runBackup writes one snapshot per day and prunes old ones', () => {
  const dataDir = join(tmpdir(), `nodefav-backup-test-${process.pid}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  try {
    const db = createDb(dataDir);
    applyOps(db, [createBookmark('persisted', 1_000)]);

    const now = Date.UTC(2026, 6, 3, 12);
    const first = runBackup(db, dataDir, 7, now);
    assert.equal(first.created, true);
    assert.ok(existsSync(first.path));
    assert.match(first.path, /nodefav-2026-07-03\.sqlite$/);

    // The snapshot is a valid database containing the row.
    const snapshot = new Database(first.path, { readonly: true });
    const row = snapshot.prepare('select count(*) as n from bookmarks').get() as { n: number };
    snapshot.close();
    assert.equal(row.n, 1);

    const again = runBackup(db, dataDir, 7, now);
    assert.equal(again.created, false);

    // Prune: seed older files beyond the keep window.
    for (let day = 1; day <= 9; day += 1) {
      const name = `nodefav-2026-06-${String(day).padStart(2, '0')}.sqlite`;
      writeFileSync(join(dataDir, 'backups', name), 'x');
    }
    const pruned = runBackup(db, dataDir, 7, now);
    const kept = readdirSync(join(dataDir, 'backups')).filter((f) => f.startsWith('nodefav-'));
    assert.equal(kept.length, 7);
    assert.ok(kept.includes('nodefav-2026-07-03.sqlite'));
    assert.equal(pruned.pruned, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
