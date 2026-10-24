import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICE_REPORT_INTERVAL_MS,
  compareVersions,
  defaultDeviceName,
  reportDue,
} from './device.js';

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const hints = { userAgent: CHROME_UA, os: 'linux', isBrave: false, rootTitles: ['Bookmarks bar'] };

test('default device name guesses browser and OS', () => {
  assert.equal(defaultDeviceName(hints), 'Chrome on Linux');
  assert.equal(defaultDeviceName({ ...hints, isBrave: true }), 'Brave on Linux');
  assert.equal(
    defaultDeviceName({ ...hints, userAgent: `${CHROME_UA} Edg/130.0.0.0`, os: 'win' }),
    'Edge on Windows',
  );
  assert.equal(
    defaultDeviceName({ ...hints, userAgent: `${CHROME_UA} OPR/115.0.0.0`, os: 'mac' }),
    'Opera on macOS',
  );
  assert.equal(
    defaultDeviceName({ ...hints, rootTitles: ['Bookmarks', 'Trash', 'Other bookmarks'] }),
    'Vivaldi on Linux',
  );
  // Opera also has a Trash root, but alongside Speed Dial.
  assert.equal(
    defaultDeviceName({ ...hints, rootTitles: ['Trash', 'Speed Dial'] }),
    'Chrome on Linux',
  );
});

test('device report is due on any change or once the interval passes', () => {
  const last = { serverUrl: 'https://a', name: 'Edge', version: '0.4.0', at: 1_000 };
  assert.equal(reportDue(undefined, last), true);
  assert.equal(reportDue(last, { ...last, at: 2_000 }), false);
  assert.equal(reportDue(last, { ...last, name: 'Edge – work', at: 2_000 }), true);
  assert.equal(reportDue(last, { ...last, version: '0.4.1', at: 2_000 }), true);
  assert.equal(reportDue(last, { ...last, serverUrl: 'https://b', at: 2_000 }), true);
  assert.equal(reportDue(last, { ...last, at: 1_000 + DEVICE_REPORT_INTERVAL_MS }), true);
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('0.4', '0.4.0'), 0);
  assert.equal(compareVersions('0.3.1', '0.4.0'), -1);
});
