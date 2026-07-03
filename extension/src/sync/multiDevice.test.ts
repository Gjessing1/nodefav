import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { FakeSyncServer } from '../testing/fakeServer.js';
import { createHarness, serverSnapshot } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';

/**
 * Phase 4 concurrent-edit matrix: two profiles (A and B) on one server.
 * "Concurrent" means both devices edit before either syncs; the shared
 * strictly-increasing clock makes LWW outcomes deterministic in edit order.
 */

interface Pair {
  server: FakeSyncServer;
  a: Harness;
  b: Harness;
}

async function twoProfiles(seed?: (fake: FakeBookmarks) => Promise<void>): Promise<Pair> {
  const server = new FakeSyncServer();
  let tick = 1_000_000;
  const now = () => ++tick;
  const fakeA = new FakeBookmarks();
  if (seed) await seed(fakeA);
  const a = createHarness({ fake: fakeA, server, now });
  await a.engine.sync();
  await a.engine.idle();
  const b = createHarness({ server, now });
  await b.engine.sync();
  await b.engine.idle();
  return { server, a, b };
}

/**
 * Syncs the given profiles until quiescent, then asserts every browser tree
 * and the server tree are identical. Sync order matters for arrival order at
 * the server — pass profiles in the order they should reach it.
 */
async function converge(...hs: Harness[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const h of hs) {
      await h.engine.sync({ force: true });
      await h.engine.idle();
    }
  }
  const reference = hs[0] as Harness;
  const expected = reference.fake.snapshot();
  for (const h of hs.slice(1)) {
    assert.deepEqual(h.fake.snapshot(), expected, 'browser trees diverged');
  }
  assert.deepEqual(await serverSnapshot(reference.server), expected, 'server tree diverged');
  for (const h of hs) {
    const status = await h.engine.status();
    assert.equal(status.queueDepth, 0);
    assert.equal(status.lastError, undefined);
  }
}

/** Browser id of the first node with this title, searched depth-first. */
async function findByTitle(fake: FakeBookmarks, title: string): Promise<string> {
  const walk = async (id: string): Promise<string | undefined> => {
    for (const child of await fake.getChildren(id)) {
      if (child.title === title) return child.id;
      if (child.url === undefined) {
        const hit = await walk(child.id);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const hit = await walk('0');
  assert.ok(hit !== undefined, `no node titled "${title}"`);
  return hit;
}

function titlesIn(h: Harness, rootIndex: number): string[] {
  const root = h.fake.snapshot()[rootIndex] as { children: Array<{ title: string }> };
  return root.children.map((c) => c.title);
}

async function seedShared(fake: FakeBookmarks): Promise<void> {
  const f = await fake.create({ parentId: '1', title: 'Shared' });
  await fake.create({ parentId: f.id, title: 'X', url: 'https://x.example/' });
  await fake.create({ parentId: '1', title: 'News', url: 'https://news.example/' });
}

test('second profile materializes the first profile’s tree', async () => {
  const { a, b } = await twoProfiles(seedShared);
  assert.deepEqual(b.fake.snapshot(), a.fake.snapshot());
  await converge(a, b);
});

test('edits made on either device propagate to the other', async () => {
  const { a, b } = await twoProfiles(seedShared);

  await a.fake.create({ parentId: '1', title: 'From A', url: 'https://a.example/' });
  await converge(a, b);

  await b.fake.update(await findByTitle(b.fake, 'From A'), { title: 'Renamed by B' });
  await converge(b, a);

  await a.fake.move(await findByTitle(a.fake, 'Renamed by B'), { parentId: '2', index: 0 });
  await converge(a, b);

  await b.fake.removeTree(await findByTitle(b.fake, 'Renamed by B'));
  await converge(b, a);
});

test('same-field LWW: the later of two concurrent renames wins everywhere', async () => {
  const { a, b } = await twoProfiles(seedShared);

  await a.fake.update(await findByTitle(a.fake, 'X'), { title: 'Recipes' });
  await a.engine.idle(); // capture A's timestamp before B edits
  await b.fake.update(await findByTitle(b.fake, 'X'), { title: 'Cooking' });
  await b.engine.idle();

  await converge(a, b);
  await findByTitle(a.fake, 'Cooking');
  await findByTitle(b.fake, 'Cooking');

  // Same race with the arrival order flipped: the later edit still wins even
  // when it reaches the server first (the earlier one lands as stale).
  await b.fake.update(await findByTitle(b.fake, 'Cooking'), { title: 'Baking' });
  await b.engine.idle();
  await a.fake.update(await findByTitle(a.fake, 'Cooking'), { title: 'Grilling' });
  await a.engine.idle();

  await converge(a, b);
  await findByTitle(a.fake, 'Grilling');
  await findByTitle(b.fake, 'Grilling');
});

test('different fields merge: a rename and a move both survive', async () => {
  const { a, b } = await twoProfiles(seedShared);

  await a.fake.update(await findByTitle(a.fake, 'X'), { title: 'X renamed' });
  await a.engine.idle();
  await b.fake.move(await findByTitle(b.fake, 'X'), { parentId: '2', index: 0 });
  await b.engine.idle();

  await converge(a, b);
  // Both effects present on both devices: new title, new parent.
  for (const h of [a, b]) {
    const other = h.fake.snapshot()[1] as { children: Array<{ title: string }> };
    assert.deepEqual(
      other.children.map((c) => c.title),
      ['X renamed'],
    );
  }
});

test('delete vs concurrent edit: the delete wins, no resurrection', async () => {
  const { a, b } = await twoProfiles(seedShared);

  await a.fake.removeTree(await findByTitle(a.fake, 'News'));
  await a.engine.idle();
  await b.fake.update(await findByTitle(b.fake, 'News'), { title: 'News edited' });
  await b.engine.idle();

  await converge(a, b);
  for (const h of [a, b]) {
    assert.deepEqual(
      titlesIn(h, 0).filter((t) => t.startsWith('News')),
      [],
    );
  }
});

test('folder delete vs concurrent create inside it: subtree stays gone', async () => {
  // Arrival order 1: the delete reaches the server first, the create is rejected.
  {
    const { a, b } = await twoProfiles(seedShared);
    await a.fake.removeTree(await findByTitle(a.fake, 'Shared'));
    await a.engine.idle();
    await b.fake.create({
      parentId: await findByTitle(b.fake, 'Shared'),
      title: 'Late child',
      url: 'https://late.example/',
    });
    await b.engine.idle();

    await converge(a, b);
    assert.deepEqual(titlesIn(a, 0), ['News']);
  }

  // Arrival order 2: the create lands first, the delete cascades over it.
  {
    const { a, b } = await twoProfiles(seedShared);
    await a.fake.removeTree(await findByTitle(a.fake, 'Shared'));
    await a.engine.idle();
    await b.fake.create({
      parentId: await findByTitle(b.fake, 'Shared'),
      title: 'Late child',
      url: 'https://late.example/',
    });
    await b.engine.idle();

    await converge(b, a);
    assert.deepEqual(titlesIn(a, 0), ['News']);
  }
});

test('concurrent inserts at the same position converge on one order', async () => {
  const { a, b } = await twoProfiles();

  // Identical fractional keys on both devices — only the uuid tie-break can
  // order them, and it must do so identically everywhere.
  await a.fake.create({ parentId: '1', index: 0, title: 'A1', url: 'https://a1.example/' });
  await a.fake.create({ parentId: '1', index: 1, title: 'A2', url: 'https://a2.example/' });
  await a.engine.idle();
  await b.fake.create({ parentId: '1', index: 0, title: 'B1', url: 'https://b1.example/' });
  await b.fake.create({ parentId: '1', index: 1, title: 'B2', url: 'https://b2.example/' });
  await b.engine.idle();

  await converge(a, b);
  assert.equal(titlesIn(a, 0).length, 4);
  assert.deepEqual(titlesIn(a, 0), titlesIn(b, 0));
});

test('a rebalance on one device converges cleanly on the other', async () => {
  const { a, b } = await twoProfiles(seedShared);

  for (let i = 0; i < 150; i += 1) {
    await a.fake.create({ parentId: '1', index: 0, title: `b${i}`, url: `https://x.example/${i}` });
  }
  await a.engine.idle();
  assert.ok(
    a.logged.some((line) => line.includes('rebalancing')),
    'a rebalance happened on A',
  );

  await converge(a, b);
  assert.equal(titlesIn(b, 0).length, 152); // 150 + Shared + News
  assert.deepEqual(titlesIn(a, 0), titlesIn(b, 0));
});
