import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CreateOp } from '@nodefav/shared';
import { buildApp } from '../app.js';
import { createDb } from '../database/db.js';

const TOKEN = 'test-token';

// SSE can't go through app.inject (it never ends the response), so these tests
// run against a real listening socket and a streaming fetch.
async function listeningApp(): Promise<{ app: FastifyInstance; base: string }> {
  const app = buildApp({ db: createDb(':memory:'), syncToken: TOKEN, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return { app, base: `http://127.0.0.1:${address.port}` };
}

interface SseEvent {
  event: string;
  data: string;
}

/** Opens the event stream and hands back a pull-based event reader. */
async function openStream(base: string, token = TOKEN) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const waiters: Array<(event: SseEvent) => void> = [];
  const push = (event: SseEvent): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else events.push(event);
  };

  if (response.ok && response.body) {
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (data !== '') push({ event, data });
        }
      }
    })().catch(() => undefined);
  }

  return {
    response,
    next(): Promise<SseEvent> {
      const queued = events.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error('timed out waiting for SSE event')), 5000);
      });
    },
    close: () => controller.abort(),
  };
}

function versionOf(event: SseEvent): number {
  assert.equal(event.event, 'version');
  return (JSON.parse(event.data) as { serverVersion: number }).serverVersion;
}

const createOp: CreateOp = {
  opId: 'op-1',
  deviceId: 'device-test',
  timestamp: 1000,
  type: 'create',
  nodeType: 'folder',
  parentUuid: null,
  title: 'Folder',
  sortOrder: 'a0',
};

test('GET /api/events requires auth', async () => {
  const { app, base } = await listeningApp();
  try {
    const response = await fetch(`${base}/api/events`, {
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  } finally {
    await app.close();
  }
});

test('event stream sends the current version on connect and on every applied op', async () => {
  const { app, base } = await listeningApp();
  const stream = await openStream(base);
  try {
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(versionOf(await stream.next()), 0);

    const post = await fetch(`${base}/api/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [createOp] }),
    });
    assert.equal(post.status, 200);
    await post.body?.cancel();

    assert.equal(versionOf(await stream.next()), 1);
  } finally {
    stream.close();
    await app.close();
  }
});

test('duplicate uploads do not emit version events', async () => {
  const { app, base } = await listeningApp();
  const stream = await openStream(base);
  try {
    assert.equal(versionOf(await stream.next()), 0);
    for (let i = 0; i < 2; i++) {
      const post = await fetch(`${base}/api/ops`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [createOp] }),
      });
      assert.equal(post.status, 200);
      await post.body?.cancel();
    }
    // Exactly one version event follows: the duplicate publishes nothing, so
    // the next event we see is the first upload's.
    assert.equal(versionOf(await stream.next()), 1);

    // Prove the stream is quiet by pushing one more applied op through and
    // seeing its version (2) as the immediate next event.
    const post = await fetch(`${base}/api/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ ...createOp, opId: 'op-2', title: 'Another' }] }),
    });
    assert.equal(post.status, 200);
    await post.body?.cancel();
    assert.equal(versionOf(await stream.next()), 2);
  } finally {
    stream.close();
    await app.close();
  }
});

test('open streams are counted in stats and closed on shutdown', async () => {
  const { app, base } = await listeningApp();
  const stream = await openStream(base);
  try {
    assert.equal(versionOf(await stream.next()), 0);
    const res = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const stats = (await res.json()) as { realtime: { eventStreams: number } };
    assert.equal(stats.realtime.eventStreams, 1);
  } finally {
    // No stream.close(): app.close() must end the hijacked response itself,
    // otherwise this await hangs and the test times out.
    await app.close();
  }
});
