/**
 * Device identity shown in the options page and reported to the backend's
 * device registry. The name is a user-editable label; the default is a guess
 * from the browser and OS, made once and then stored.
 */

/** Re-report at least this often so "last seen" stays meaningful. */
export const DEVICE_REPORT_INTERVAL_MS = 6 * 60 * 60_000;

export interface DeviceReport {
  serverUrl: string;
  name: string;
  version: string;
  at: number;
}

export interface BrowserHints {
  userAgent: string;
  /** chrome.runtime.getPlatformInfo().os */
  os: string;
  isBrave: boolean;
  /** Titles of the permanent bookmark roots (Vivaldi is only recognisable by its Trash root). */
  rootTitles: string[];
}

const OS_NAMES: Record<string, string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
  openbsd: 'OpenBSD',
  fuchsia: 'Fuchsia',
};

export function defaultDeviceName({ userAgent, os, isBrave, rootTitles }: BrowserHints): string {
  const titles = new Set(rootTitles.map((title) => title.trim().toLowerCase()));
  let browser = 'Chrome';
  if (isBrave) browser = 'Brave';
  else if (/\bEdg\//.test(userAgent)) browser = 'Edge';
  else if (/\bOPR\//.test(userAgent)) browser = 'Opera';
  else if (/Vivaldi/.test(userAgent) || (titles.has('trash') && !titles.has('speed dial'))) {
    browser = 'Vivaldi';
  }
  return `${browser} on ${OS_NAMES[os] ?? os}`;
}

/** Report when anything changed, or the last report is getting old. */
export function reportDue(last: DeviceReport | undefined, current: DeviceReport): boolean {
  return (
    last === undefined ||
    last.serverUrl !== current.serverUrl ||
    last.name !== current.name ||
    last.version !== current.version ||
    current.at - last.at >= DEVICE_REPORT_INTERVAL_MS
  );
}

/** Numeric dotted-version comparison (Chrome versions are 1-4 integers). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** The stored device name; on first use, guesses one and stores it so it stays stable. */
export async function getDeviceName(): Promise<string> {
  const { deviceName } = (await chrome.storage.local.get('deviceName')) as { deviceName?: string };
  if (deviceName) return deviceName;
  const [{ os }, tree] = await Promise.all([
    chrome.runtime.getPlatformInfo(),
    chrome.bookmarks.getTree(),
  ]);
  const name = defaultDeviceName({
    userAgent: navigator.userAgent,
    os,
    isBrave: 'brave' in navigator,
    rootTitles: (tree[0]?.children ?? []).map((root) => root.title),
  });
  await chrome.storage.local.set({ deviceName: name });
  return name;
}

export function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}
