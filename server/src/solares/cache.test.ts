import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../cache.js';

const counter = () => { let calls = 0; return { fn: async () => ++calls, get calls() { return calls; } }; };

test('expired entries are swept and refetched instead of retained forever', async () => {
  let now = 0;
  const cache = new TtlCache({ sweepIntervalMs: 1_000, now: () => now });
  const upstream = counter();
  for (let i = 0; i < 50; i++) await cache.wrap(`safety:${i}`, 100, upstream.fn);
  assert.equal(cache.size, 50);
  now = 5_000;
  await cache.wrap('safety:fresh', 100, upstream.fn);
  assert.equal(cache.size, 1, 'expired caller-keyed entries must not accumulate');
  const before = upstream.calls;
  assert.equal(await cache.wrap('safety:0', 100, upstream.fn), before + 1);
});

test('entry count is bounded with oldest-first eviction', async () => {
  const cache = new TtlCache({ maxEntries: 3 });
  const upstream = counter();
  for (const key of ['a', 'b', 'c', 'd']) await cache.wrap(key, 60_000, upstream.fn);
  assert.equal(cache.size, 3);
  assert.equal(upstream.calls, 4);
  await cache.wrap('d', 60_000, upstream.fn);
  assert.equal(upstream.calls, 4, 'newest entry is still cached');
  await cache.wrap('a', 60_000, upstream.fn);
  assert.equal(upstream.calls, 5, 'oldest entry was evicted');
  for (let i = 0; i < 1_000; i++) await cache.wrap(`flood:${i}`, 60_000, upstream.fn);
  assert.equal(cache.size, 3);
});

test('concurrent callers still share one upstream request and failures are not cached', async () => {
  const cache = new TtlCache({ maxEntries: 1 });
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fn = async () => { calls++; await gate; return 'value'; };
  const pending = [cache.wrap('k', 60_000, fn), cache.wrap('k', 60_000, fn), cache.wrap('k', 60_000, fn)];
  release();
  assert.deepEqual(await Promise.all(pending), ['value', 'value', 'value']);
  assert.equal(calls, 1);
  await assert.rejects(cache.wrap('bad', 60_000, async () => { throw new Error('upstream down'); }));
  assert.equal(await cache.wrap('bad', 60_000, async () => 'recovered'), 'recovered');
});
