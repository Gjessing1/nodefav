import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { compareVersions, publishWebStore } from './publish-webstore.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  CWS_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'release@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
  CWS_PUBLISHER_ID: 'publisher',
  CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
};
const directory = mkdtempSync(join(tmpdir(), 'nodefav-webstore-'));
const zipPath = join(directory, 'extension.zip');
writeFileSync(zipPath, 'zip bytes');
after(() => rmSync(directory, { recursive: true, force: true }));

const revision = (state, crxVersion) => ({ state, distributionChannels: [{ crxVersion }] });

/** Fake fetch answering by endpoint; records every call. */
function store(status, { uploadState = 'SUCCEEDED', asyncStates = [] } = {}) {
  const calls = [];
  const fetchFn = (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2')) return Response.json({ access_token: 'token' });
    if (url.endsWith(':fetchStatus')) {
      return calls.filter((call) => call.url.endsWith(':upload')).length === 0
        ? Response.json(status)
        : Response.json({ lastAsyncUploadState: asyncStates.shift() });
    }
    if (url.endsWith(':cancelSubmission')) return new Response('');
    if (url.endsWith(':upload')) return Response.json({ uploadState });
    if (url.endsWith(':publish')) return Response.json({ state: 'PENDING_REVIEW' });
    throw new Error(`unexpected ${url}`);
  };
  const paths = () => calls.map((call) => call.url.split(/items\/[a-z]+/)[1] ?? 'token');
  return { calls, fetchFn, paths };
}

const run = (fake, version, extra = {}) =>
  publishWebStore({ zipPath, version, env, fetchFn: fake.fetchFn, log: () => undefined, ...extra });

test('compares dotted versions numerically', () => {
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('0.3', '0.3.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('does nothing when no store secrets are configured', async () => {
  const fake = store({});
  const result = await publishWebStore({
    zipPath,
    version: '0.3.2',
    env: {},
    fetchFn: fake.fetchFn,
    log: () => undefined,
  });
  assert.deepEqual(result, { action: 'skipped', reason: 'not-configured' });
  assert.equal(fake.calls.length, 0);
});

test('rejects a partial secret configuration', async () => {
  await assert.rejects(
    publishWebStore({ zipPath, version: '0.3.2', env: { CWS_PUBLISHER_ID: 'p' } }),
    /missing CWS_SERVICE_ACCOUNT_JSON, CWS_EXTENSION_ID/,
  );
});

test('skips a version the store already publishes', async () => {
  const fake = store({ publishedItemRevisionStatus: revision('PUBLISHED', '0.3.1') });
  assert.deepEqual(await run(fake, '0.3.1'), { action: 'skipped', reason: 'published' });
  assert.deepEqual(fake.paths(), ['token', ':fetchStatus']);
});

test('skips a version already under review', async () => {
  const fake = store({
    publishedItemRevisionStatus: revision('PUBLISHED', '0.3.0'),
    submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.1'),
  });
  assert.deepEqual(await run(fake, '0.3.1'), { action: 'skipped', reason: 'pending-review' });
  assert.deepEqual(fake.paths(), ['token', ':fetchStatus']);
});

test('signs the token, uploads the zip and submits a newer version', async () => {
  const fake = store({ publishedItemRevisionStatus: revision('PUBLISHED', '0.3.1') });
  assert.deepEqual(await run(fake, '0.3.2'), { action: 'submitted', state: 'PENDING_REVIEW' });
  assert.deepEqual(fake.paths(), ['token', ':fetchStatus', ':upload', ':publish']);

  const [header, payload, signature] = new URLSearchParams(fake.calls[0].init.body)
    .get('assertion')
    .split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(
    JSON.parse(Buffer.from(payload, 'base64url').toString()).scope,
    'https://www.googleapis.com/auth/chromewebstore',
  );
  const upload = fake.calls[2];
  assert.match(
    upload.url,
    /\/upload\/v2\/publishers\/publisher\/items\/abcdefghijklmnopabcdefghijklmnop:upload$/,
  );
  assert.equal(upload.init.body.toString(), 'zip bytes');
  assert.deepEqual(JSON.parse(fake.calls[3].init.body), {
    publishType: 'DEFAULT_PUBLISH',
    blockOnWarnings: true,
  });
});

test('replaces an older pending review with the newer version', async () => {
  const fake = store({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.3.1') });
  assert.equal((await run(fake, '0.3.2')).action, 'submitted');
  assert.deepEqual(fake.paths(), [
    'token',
    ':fetchStatus',
    ':cancelSubmission',
    ':upload',
    ':publish',
  ]);
});

test('waits for an async upload and fails on an unsuccessful one', async () => {
  let waits = 0;
  const sleep = () => {
    waits += 1;
  };
  const ok = store({}, { uploadState: 'IN_PROGRESS', asyncStates: ['IN_PROGRESS', 'SUCCEEDED'] });
  assert.equal((await run(ok, '0.3.2', { sleep })).action, 'submitted');
  assert.equal(waits, 2);

  const failed = store({}, { uploadState: 'FAILED' });
  await assert.rejects(run(failed, '0.3.2'), /upload state: FAILED/);
  assert.ok(!failed.calls.some((call) => call.url.endsWith(':publish')));
});
