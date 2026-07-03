export const DEFAULT_SYNC_INTERVAL_MINUTES = 1;
export const MIN_SYNC_INTERVAL_MINUTES = 1; // chrome.alarms floor in MV3
export const MAX_SYNC_INTERVAL_MINUTES = 60;

/** Clamps arbitrary input to a usable alarm period. */
export function normalizeSyncInterval(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_SYNC_INTERVAL_MINUTES;
  return Math.min(
    Math.max(Math.round(minutes), MIN_SYNC_INTERVAL_MINUTES),
    MAX_SYNC_INTERVAL_MINUTES,
  );
}

export async function getSyncInterval(): Promise<number> {
  const { syncIntervalMinutes } = (await chrome.storage.local.get('syncIntervalMinutes')) as {
    syncIntervalMinutes?: number;
  };
  return syncIntervalMinutes === undefined
    ? DEFAULT_SYNC_INTERVAL_MINUTES
    : normalizeSyncInterval(syncIntervalMinutes);
}
