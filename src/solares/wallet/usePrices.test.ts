import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES_PATH, createPriceStore } from './usePrices';
import type { PricesState } from './prices';

const BODY = {
  prices: { solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } } },
  observedAt: '2026-10-14T05:00:52.000Z',
  source: 'Relay',
};
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
type Answer = { ok: boolean; body: unknown } | 'hang' | Error;
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === 'hang') return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve({ ok: answer.ok, json: async () => answer.body });
  };
  return { fetch, calls };
}

test('the first subscriber reads the prices once; others share the snapshot', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, body: BODY }]);
  const store = createPriceStore({ url: `https://antara.test${PRICES_PATH}`, fetch, refreshMs: 60_000, hidden: () => false });
  assert.deepEqual(store.getState(), { status: 'loading' });
  const seen: PricesState[] = [];
  const stopA = store.subscribe(() => seen.push(store.getState()));
  const stopB = store.subscribe(() => {});
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://antara.test/api/solares/wallet/prices');
  assert.equal(store.getState().status, 'ready');
  assert.equal(seen.length, 1);
  stopA(); stopB();
});

test('a failed read is unavailable, never a guessed price; a failed refresh keeps a recent snapshot', async () => {
  const failing = fakeFetch([{ ok: false, body: { error: 'Prices are unavailable right now.' } }]);
  const store = createPriceStore({ fetch: failing.fetch, refreshMs: 60_000, hidden: () => false });
  const stop = store.subscribe(() => {});
  await tick();
  assert.deepEqual(store.getState(), { status: 'unavailable' });
  stop();

  let now = Date.parse(BODY.observedAt);
  const flaky = fakeFetch([{ ok: true, body: BODY }, new Error('offline'), { ok: true, body: { nonsense: true } }]);
  const kept = createPriceStore({ fetch: flaky.fetch, refreshMs: 5, now: () => now, hidden: () => false });
  const stopKept = kept.subscribe(() => {});
  await tick();
  assert.equal(kept.getState().status, 'ready');
  await tick(20);
  assert.ok(flaky.calls.length >= 2);
  assert.equal(kept.getState().status, 'ready', 'a snapshot under ten minutes old survives a failed refresh');
  now += 11 * 60_000;
  await tick(20);
  assert.deepEqual(kept.getState(), { status: 'unavailable' }, 'an old snapshot is not shown after a failed refresh');
  stopKept();
});

test('the last unsubscribe aborts the read in flight and stops refreshing', async () => {
  const { fetch, calls } = fakeFetch(['hang']);
  const store = createPriceStore({ fetch, refreshMs: 5, hidden: () => false });
  const stop = store.subscribe(() => {});
  await tick();
  assert.equal(calls.length, 1);
  stop();
  assert.equal(calls[0].init.signal?.aborted, true);
  await tick(20);
  assert.equal(calls.length, 1);
  assert.deepEqual(store.getState(), { status: 'loading' });
});

test('a read that takes too long is abandoned', async () => {
  const { fetch, calls } = fakeFetch(['hang']);
  const store = createPriceStore({ fetch, refreshMs: 60_000, timeoutMs: 5, hidden: () => false });
  const stop = store.subscribe(() => {});
  await tick(20);
  assert.equal(calls[0].init.signal?.aborted, true);
  assert.deepEqual(store.getState(), { status: 'unavailable' });
  stop();
});

test('a hidden page does not refresh', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, body: BODY }]);
  const store = createPriceStore({ fetch, refreshMs: 5, hidden: () => true });
  const stop = store.subscribe(() => {});
  await tick(20);
  assert.equal(calls.length, 0);
  stop();
});
