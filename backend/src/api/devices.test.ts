import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DeviceInfo, GetDevicesResponse } from '@nodefav/shared';
import { buildApp } from '../app.js';
import { createDb } from '../database/db.js';

const TOKEN = 'test-token';

function makeApp(): FastifyInstance {
  return buildApp({ db: createDb(':memory:'), syncToken: TOKEN, logger: false });
}

async function inject(
  app: FastifyInstance,
  method: 'GET' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, payload });
}

test('devices report name + version and are listed most recently seen first', async () => {
  const app = makeApp();
  const first = await inject(app, 'PUT', '/api/devices/dev-a', {
    name: ' Vivaldi – laptop ',
    version: '0.3.0',
  });
  assert.equal(first.statusCode, 200, first.body);
  const a = first.json() as DeviceInfo;
  assert.equal(a.name, 'Vivaldi – laptop');
  assert.equal(a.version, '0.3.0');

  await new Promise((done) => setTimeout(done, 5));
  await inject(app, 'PUT', '/api/devices/dev-b', { name: 'Edge', version: '0.4.0' });
  let listed = (await inject(app, 'GET', '/api/devices')).json() as GetDevicesResponse;
  assert.deepEqual(
    listed.devices.map((device) => device.deviceId),
    ['dev-b', 'dev-a'],
  );

  // A later report from the same device updates it in place.
  await new Promise((done) => setTimeout(done, 5));
  await inject(app, 'PUT', '/api/devices/dev-a', { name: 'Vivaldi', version: '0.4.0' });
  listed = (await inject(app, 'GET', '/api/devices')).json() as GetDevicesResponse;
  assert.equal(listed.devices.length, 2);
  assert.deepEqual(
    { ...listed.devices[0], lastSeenAt: 0 },
    { deviceId: 'dev-a', name: 'Vivaldi', version: '0.4.0', lastSeenAt: 0 },
  );
});

test('device reports are validated', async () => {
  const app = makeApp();
  for (const payload of [
    {},
    { name: '', version: '0.4.0' },
    { name: 'x'.repeat(101), version: '0.4.0' },
    { name: 'Edge', version: 'latest' },
    { name: 'Edge', version: '1.2.3.4.5' },
  ]) {
    const res = await inject(app, 'PUT', '/api/devices/dev-a', payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  const listed = (await inject(app, 'GET', '/api/devices')).json() as GetDevicesResponse;
  assert.deepEqual(listed.devices, []);
});

test('device endpoints require the bearer token', async () => {
  const app = makeApp();
  for (const [method, url] of [
    ['GET', '/api/devices'],
    ['PUT', '/api/devices/dev-a'],
  ] as const) {
    const res = await app.inject({ method, url, payload: { name: 'x', version: '1' } });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});
