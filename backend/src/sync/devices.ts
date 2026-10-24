import { desc } from 'drizzle-orm';
import type { DeviceInfo, PutDeviceRequest } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { devices } from '../database/schema.js';

const MAX_NAME_LENGTH = 100;
const VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/;

/** Validates a device report body; returns an error message or the clean values. */
export function validateDeviceReport(body: unknown): PutDeviceRequest | { error: string } {
  const { name, version } = (body ?? {}) as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name must be a non-empty string' };
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return { error: 'version must be a dotted version like 0.3.1' };
  }
  return { name: name.trim(), version };
}

export function upsertDevice(
  db: Db,
  deviceId: string,
  report: PutDeviceRequest,
  now: number,
): DeviceInfo {
  const row = { deviceId, name: report.name, version: report.version, lastSeenAt: now };
  db.insert(devices)
    .values(row)
    .onConflictDoUpdate({
      target: devices.deviceId,
      set: { name: row.name, version: row.version, lastSeenAt: row.lastSeenAt },
    })
    .run();
  return row;
}

export function listDevices(db: Db): DeviceInfo[] {
  return db.select().from(devices).orderBy(desc(devices.lastSeenAt)).all();
}
