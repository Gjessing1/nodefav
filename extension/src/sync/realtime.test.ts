import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealtimeClient, createSseParser } from './realtime.js';
import type { RealtimeEnv } from './realtime.js';

// --- SSE parser ---------------------------------------------------------

function collect(): { events: Array<[string, string]>; on: (e: string, d: string) => void } {
  const events: Array<[string, string]> = [];
  return { events, on: (e, d) => events.push([e, d]) };
}

test('parser dispatches events split across arbitrary chunk boundaries', () => {
  const { events, on } = collect();
  const feed = createSseParser(on);
  const stream =
    'event: version\ndata: {"serverVersion":7}\n\nevent: version\ndata: {"serverVersion":8}\n\n';
  // Feed one character at a time — worst-case fragmentation.
  for (const ch of stream) feed(ch);
  assert.deepEqual(events, [
    ['version', '{"serverVersion":7}'],
    ['version', '{"serverVersion":8}'],
  ]);
});

test('parser ignores comments, joins data lines, defaults the event type', () => {
  const { events, on } = collect();
  const feed = createSseParser(on);
  feed(': heartbeat\n\n'); // comment-only block → no event
  feed('data: a\ndata: b\n\n');
  feed('retry: 1000\ndata:c\n\n'); // unknown field ignored, no-space data
  assert.deepEqual(events, [
    ['message', 'a\nb'],
    ['message', 'c'],
  ]);
});

test('parser handles CRLF line endings, including a CRLF split across chunks', () => {
  const { events, on } = collect();
  const feed = createSseParser(on);
  feed('event: version\r');
  feed('\ndata: 1\r\n\r\n');
  assert.deepEqual(events, [['version', '1']]);
});

// --- RealtimeClient ------------------------------------------------------

/** A fetch stub serving scripted SSE bodies; each connect consumes one script entry. */
function fakeEventsServer(bodies: Array<string[] | { status: number }>) {
  let connects = 0;
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchFn: typeof fetch = (_url, init) => {
    const script = bodies[Math.min(connects, bodies.length - 1)] ?? { status: 500 };
    connects++;
    if (!Array.isArray(script)) {
      return Promise.resolve(new Response(null, { status: script.status }));
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        for (const chunk of script) controller.enqueue(encoder.encode(chunk));
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  return {
    fetchFn,
    get connects() {
      return connects;
    },
    closeCurrent: () => controllers[controllers.length - 1]?.close(),
  };
}

function makeEnv(fetchFn: typeof fetch, overrides: Partial<RealtimeEnv> = {}) {
  const versions: number[] = [];
  const env: RealtimeEnv = {
    getConfig: () => Promise.resolve({ serverUrl: 'https://cloud.test/', token: 't' }),
    onVersion: (v) => versions.push(v),
    keepalive: () => undefined,
    log: () => undefined,
    fetchFn,
    minReconnectMs: 5,
    maxReconnectMs: 20,
    keepaliveMs: 5,
    stallMs: 10_000,
    ...overrides,
  };
  return { env, versions };
}

function until(check: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 3000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 2);
  });
}

test('client connects, reports versions, reconnects when the server closes', async () => {
  const server = fakeEventsServer([
    ['event: version\ndata: {"serverVersion":3}\n\n'],
    ['event: version\ndata: {"serverVersion":4}\n\n'],
  ]);
  const { env, versions } = makeEnv(server.fetchFn);
  const client = new RealtimeClient(env);
  client.ensureConnected();

  await until(() => versions.includes(3), 'first version event');
  assert.equal(client.state, 'connected');
  server.closeCurrent();
  await until(() => versions.includes(4), 'version event after reconnect');
  assert.equal(server.connects, 2);
  client.disconnect();
  assert.equal(client.state, 'off');
});

test('client stays off while unconfigured and starts after restart()', async () => {
  const server = fakeEventsServer([['event: version\ndata: {"serverVersion":1}\n\n']]);
  let config: { serverUrl: string; token: string } | null = null;
  const { env, versions } = makeEnv(server.fetchFn, {
    getConfig: () => Promise.resolve(config),
  });
  const client = new RealtimeClient(env);
  client.ensureConnected();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.connects, 0);
  assert.equal(client.state, 'off');

  config = { serverUrl: 'https://cloud.test', token: 't' };
  client.restart();
  await until(() => versions.includes(1), 'version after configuration');
  client.disconnect();
});

test('client retries with backoff after HTTP errors and recovers', async () => {
  const server = fakeEventsServer([
    { status: 401 },
    { status: 401 },
    ['event: version\ndata: {"serverVersion":9}\n\n'],
  ]);
  const { env, versions } = makeEnv(server.fetchFn);
  const client = new RealtimeClient(env);
  client.ensureConnected();
  await until(() => versions.includes(9), 'recovery after HTTP errors');
  assert.equal(server.connects, 3);
  assert.equal(client.state, 'connected');
  client.disconnect();
});

test('ensureConnected is idempotent — one loop, one connection', async () => {
  const server = fakeEventsServer([['event: version\ndata: {"serverVersion":1}\n\n']]);
  const { env, versions } = makeEnv(server.fetchFn);
  const client = new RealtimeClient(env);
  client.ensureConnected();
  client.ensureConnected();
  client.ensureConnected();
  await until(() => versions.length > 0, 'first event');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.connects, 1);
  client.disconnect();
});
