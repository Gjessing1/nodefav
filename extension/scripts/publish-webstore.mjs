import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const STORE = 'https://chromewebstore.googleapis.com';
const SECRETS = ['CWS_SERVICE_ACCOUNT_JSON', 'CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID'];

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** Numeric dotted-version comparison (Chrome versions are 1-4 integers). */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function serviceAccountAssertion(account, now) {
  if (!account.client_email || !account.private_key) {
    throw new Error('CWS_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
}

async function responseJson(response, action) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body.error?.message ?? body.error_description ?? response.statusText;
    throw new Error(`${action} failed (${response.status}): ${message}`);
  }
  return body;
}

/**
 * Upload a release zip and submit it for review when `version` is newer than
 * what the store already has published or under review. An older pending
 * submission is cancelled so the newest version is the one reviewed. Without
 * the CWS_* secrets it does nothing, so CI stays green before setup.
 */
export async function publishWebStore({
  zipPath,
  version,
  env = process.env,
  fetchFn = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = console.log,
}) {
  const missing = SECRETS.filter((name) => !env[name]);
  if (missing.length === SECRETS.length) {
    log('Chrome Web Store secrets are not configured; skipping publish.');
    return { action: 'skipped', reason: 'not-configured' };
  }
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);

  const account = JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON);
  const publisherId = encodeURIComponent(env.CWS_PUBLISHER_ID);
  const extensionId = encodeURIComponent(env.CWS_EXTENSION_ID);
  const item = `publishers/${publisherId}/items/${extensionId}`;
  const tokenResponse = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: serviceAccountAssertion(account, now()),
    }),
  });
  const { access_token: token } = await responseJson(tokenResponse, 'OAuth token request');
  if (!token) throw new Error('OAuth token response did not contain an access token');
  const authorization = { Authorization: `Bearer ${token}` };
  const fetchStatus = async () =>
    responseJson(
      await fetchFn(`${STORE}/v2/${item}:fetchStatus`, { headers: authorization }),
      'Chrome Web Store status check',
    );

  const status = await fetchStatus();
  const published = status.publishedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
  const submitted = status.submittedItemRevisionStatus;
  const submittedVersion = submitted?.distributionChannels?.[0]?.crxVersion;
  if (published && compareVersions(version, published) <= 0) {
    log(`Chrome Web Store already publishes ${published}; nothing to do for ${version}.`);
    return { action: 'skipped', reason: 'published' };
  }
  if (
    submitted?.state === 'PENDING_REVIEW' &&
    submittedVersion &&
    compareVersions(version, submittedVersion) <= 0
  ) {
    log(`Chrome Web Store is already reviewing ${submittedVersion}; nothing to do for ${version}.`);
    return { action: 'skipped', reason: 'pending-review' };
  }
  if (submitted?.state === 'PENDING_REVIEW') {
    const cancel = await fetchFn(`${STORE}/v2/${item}:cancelSubmission`, {
      method: 'POST',
      headers: authorization,
    });
    await responseJson(cancel, 'Chrome Web Store review cancellation');
    log(`Cancelled pending review of ${submittedVersion ?? 'an older version'}.`);
  }

  const uploadResponse = await fetchFn(`${STORE}/upload/v2/${item}:upload`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/zip' },
    body: readFileSync(zipPath),
  });
  const upload = await responseJson(uploadResponse, 'Chrome Web Store upload');
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 30; attempt += 1) {
    await sleep(10_000);
    state = (await fetchStatus()).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload state: ${state ?? 'unknown'}`);
  }
  log(`Uploaded ${version} to the Chrome Web Store.`);

  const publishResponse = await fetchFn(`${STORE}/v2/${item}:publish`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
  });
  const submission = await responseJson(publishResponse, 'Chrome Web Store submission');
  log(`Submitted ${version} for review: ${submission.state ?? 'accepted'}`);
  return { action: 'submitted', state: submission.state };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [zipPath, version] = process.argv.slice(2);
  if (!zipPath || !version) {
    throw new Error('Usage: node publish-webstore.mjs <extension.zip> <version>');
  }
  await publishWebStore({ zipPath, version });
}
