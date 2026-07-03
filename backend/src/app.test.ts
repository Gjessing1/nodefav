import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HealthResponse } from '@nodefav/shared';
import { buildApp } from './app.js';

test('GET /health returns ok with version and git sha', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  const body = res.json() as HealthResponse;
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof body.gitSha, 'string');
  assert.ok(body.gitSha.length > 0);

  await app.close();
});

test('GET /health reflects GIT_SHA from the environment', async () => {
  process.env.GIT_SHA = 'abc1234def';
  try {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal((res.json() as HealthResponse).gitSha, 'abc1234def');
    await app.close();
  } finally {
    delete process.env.GIT_SHA;
  }
});
