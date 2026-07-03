import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyBetween } from './order.js';

test('first key and neighbors', () => {
  const first = keyBetween(null, null);
  assert.ok(first.length > 0);
  assert.ok(keyBetween(null, first) < first);
  assert.ok(keyBetween(first, null) > first);
});

test('midpoint lies strictly between bounds', () => {
  const cases: Array<[string, string]> = [
    ['1', '2'],
    ['1', 'z'],
    ['a', 'b'],
    ['a', 'a1'],
    ['az', 'b'],
    ['0001', '0002'],
    ['1', '11'],
    ['zz', 'zzz'],
  ];
  for (const [a, b] of cases) {
    const mid = keyBetween(a, b);
    assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`);
    assert.doesNotMatch(mid, /0$/, `no trailing zero: ${mid}`);
  }
});

test('repeated append and prepend stay ordered', () => {
  let key = keyBetween(null, null);
  const appended = [key];
  for (let i = 0; i < 200; i += 1) {
    key = keyBetween(key, null);
    appended.push(key);
  }
  for (let i = 1; i < appended.length; i += 1) {
    assert.ok((appended[i - 1] as string) < (appended[i] as string));
  }

  key = keyBetween(null, null);
  for (let i = 0; i < 200; i += 1) {
    const next = keyBetween(null, key);
    assert.ok(next < key);
    key = next;
  }
});

test('repeated bisection stays ordered', () => {
  let lo = keyBetween(null, null);
  let hi = keyBetween(lo, null);
  for (let i = 0; i < 100; i += 1) {
    const mid = keyBetween(lo, hi);
    assert.ok(lo < mid && mid < hi);
    if (i % 2 === 0) lo = mid;
    else hi = mid;
  }
});

test('random insertion fuzz keeps a sorted list sorted', () => {
  const keys = [keyBetween(null, null)];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < 500; i += 1) {
    const at = Math.floor(rand() * (keys.length + 1));
    const before = at === 0 ? null : (keys[at - 1] as string);
    const after = at === keys.length ? null : (keys[at] as string);
    keys.splice(at, 0, keyBetween(before, after));
  }
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test('rejects invalid inputs', () => {
  assert.throws(() => keyBetween('2', '1'));
  assert.throws(() => keyBetween('1', '1'));
  assert.throws(() => keyBetween('10', '2')); // trailing zero
  assert.throws(() => keyBetween('A', 'B')); // uppercase not in alphabet
});
