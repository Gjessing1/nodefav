import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeBookmarks } from '../testing/fakeBookmarks.js';
import { createHarness, serverSnapshot } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';

/**
 * Phase 4 initial-sync merge: both the browser and the cloud are non-empty on
 * first sync, and the user picks keep-local / keep-cloud / merge.
 */

interface Setup {
  /** The device that seeded the cloud and keeps syncing against it. */
  origin: Harness;
  /** The device joining with pre-existing local bookmarks (choice pending). */
  joiner: Harness;
}

/** Cloud seeded by `origin`; `joiner` has its own local tree and awaits a choice. */
async function bothSidesNonEmpty(): Promise<Setup> {
  let t = 1_000_000;
  const now = () => ++t;

  const originFake = new FakeBookmarks();
  const shared = await originFake.create({ parentId: '1', title: 'Shared' });
  await originFake.create({ parentId: shared.id, title: 'X', url: 'https://x.example/' });
  await originFake.create({ parentId: '1', title: 'Cloud only', url: 'https://cloud.example/' });
  const origin = createHarness({ fake: originFake, now });
  await origin.engine.sync();
  await origin.engine.idle();

  const joinerFake = new FakeBookmarks();
  const localShared = await joinerFake.create({ parentId: '1', title: 'Shared' });
  await joinerFake.create({ parentId: localShared.id, title: 'X', url: 'https://x.example/' });
  await joinerFake.create({ parentId: localShared.id, title: 'Y', url: 'https://y.example/' });
  await joinerFake.create({ parentId: '2', title: 'Local only', url: 'https://local.example/' });
  const joiner = createHarness({ fake: joinerFake, server: origin.server, now });
  await joiner.engine.sync();
  await joiner.engine.idle();
  assert.equal((await joiner.engine.status()).pendingInitialChoice, true);

  return { origin, joiner };
}

/** Both devices fully caught up, then asserted identical to the server. */
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
}

function bookmarkTitles(h: Harness): string[] {
  const titles: string[] = [];
  const walk = (nodes: Array<{ title: string; children?: unknown[] }>): void => {
    for (const node of nodes) {
      titles.push(node.title);
      if (node.children) walk(node.children as Array<{ title: string; children?: unknown[] }>);
    }
  };
  walk(h.fake.snapshot() as Array<{ title: string; children?: unknown[] }>);
  return titles.sort();
}

test('keep-local: the cloud is replaced by this browser’s tree', async () => {
  const { origin, joiner } = await bothSidesNonEmpty();

  await joiner.engine.resolveInitialChoice('keep-local');
  assert.equal((await joiner.engine.status()).initialized, true);
  assert.equal((await joiner.engine.status()).pendingInitialChoice, false);

  await converge(joiner, origin);
  const titles = bookmarkTitles(joiner);
  assert.ok(titles.includes('Y'), 'local content survives');
  assert.ok(titles.includes('Local only'), 'local content survives');
  assert.ok(!titles.includes('Cloud only'), 'cloud-only content is gone');
});

test('keep-cloud: this browser is replaced by the cloud tree', async () => {
  const { origin, joiner } = await bothSidesNonEmpty();

  await joiner.engine.resolveInitialChoice('keep-cloud');
  assert.equal((await joiner.engine.status()).initialized, true);

  await converge(joiner, origin);
  assert.deepEqual(joiner.fake.snapshot(), origin.fake.snapshot());
  const titles = bookmarkTitles(joiner);
  assert.ok(titles.includes('Cloud only'));
  assert.ok(!titles.includes('Y'), 'local-only content is gone');
  assert.ok(!titles.includes('Local only'), 'local-only content is gone');
});

test('merge: union of both trees, duplicates matched by url + title + parent', async () => {
  const { origin, joiner } = await bothSidesNonEmpty();

  await joiner.engine.resolveInitialChoice('merge');
  assert.equal((await joiner.engine.status()).initialized, true);

  await converge(joiner, origin);
  const titles = bookmarkTitles(joiner);
  assert.deepEqual(titles, bookmarkTitles(origin));
  // Union: everything from both sides present…
  for (const title of ['Shared', 'X', 'Y', 'Cloud only', 'Local only']) {
    assert.ok(titles.includes(title), `"${title}" present after merge`);
  }
  // …and the overlapping folder + bookmark were matched, not duplicated.
  assert.equal(titles.filter((t) => t === 'Shared').length, 1);
  assert.equal(titles.filter((t) => t === 'X').length, 1);
});

test('merge: matched nodes adopt cloud order; local-only nodes append', async () => {
  let t = 1_000_000;
  const now = () => ++t;

  // Cloud order in the bar: [One, Two]; joiner's local order: [Two, One, Extra].
  const originFake = new FakeBookmarks();
  await originFake.create({ parentId: '1', title: 'One', url: 'https://one.example/' });
  await originFake.create({ parentId: '1', title: 'Two', url: 'https://two.example/' });
  const origin = createHarness({ fake: originFake, now });
  await origin.engine.sync();
  await origin.engine.idle();

  const joinerFake = new FakeBookmarks();
  await joinerFake.create({ parentId: '1', title: 'Two', url: 'https://two.example/' });
  await joinerFake.create({ parentId: '1', title: 'One', url: 'https://one.example/' });
  await joinerFake.create({ parentId: '1', title: 'Extra', url: 'https://extra.example/' });
  const joiner = createHarness({ fake: joinerFake, server: origin.server, now });
  await joiner.engine.sync();
  await joiner.engine.idle();

  await joiner.engine.resolveInitialChoice('merge');
  await converge(joiner, origin);

  const bar = joiner.fake.snapshot()[0] as { children: Array<{ title: string }> };
  assert.deepEqual(
    bar.children.map((c) => c.title),
    ['One', 'Two', 'Extra'],
  );
});

test('a choice is required once — later syncs proceed normally', async () => {
  const { origin, joiner } = await bothSidesNonEmpty();
  await joiner.engine.resolveInitialChoice('merge');
  await converge(joiner, origin);

  await joiner.fake.create({ parentId: '1', title: 'After', url: 'https://after.example/' });
  await converge(joiner, origin);
  assert.ok(bookmarkTitles(origin).includes('After'));

  const status = await joiner.engine.status();
  assert.equal(status.pendingInitialChoice, false);
  assert.equal(status.lastError, undefined);
});
