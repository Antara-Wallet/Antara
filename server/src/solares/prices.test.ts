import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { PRICE_BOUNDS, RELAY_PRICE_URL, createPriceSource, parseRelayPrice, priceRequest, pricesRouter } from './prices';
import { SUPPORTED_NETWORKS, byKey } from '../../../src/solares/networks';

/** Live answers from Relay's public price endpoint, captured read-only (fixtures/relay-prices/README.md). */
const CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/relay-prices/prices.json', import.meta.url), 'utf8')) as {
  cases: Record<string, { request: { address: string; chainId: number }; status: number; body: unknown }>;
};

type Call = { url: string; init: RequestInit };
/** A fetch that replays the capture by chain id and address, recording every call. */
function replay(overrides: Record<string, { status: number; body: unknown } | Error> = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const query = new URL(url).searchParams;
    const name = Object.keys(CAPTURE.cases).find(key => {
      const item = CAPTURE.cases[key].request;
      return String(item.chainId) === query.get('chainId') && item.address === query.get('address');
    });
    const answer = (name ? overrides[name] ?? CAPTURE.cases[name] : undefined) ?? { status: 400, body: { error: 'Could not get price' } };
    if (answer instanceof Error) throw answer;
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => text };
  };
  return { fetch, calls };
}
const clock = (start = Date.parse('2026-10-14T05:00:00.000Z')) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
};

test('the capture prices every supported asset, and an unknown token is a 400', () => {
  for (const network of SUPPORTED_NETWORKS) {
    for (const kind of ['native', 'funding'] as const) {
      const asset = priceRequest(network, kind);
      const item = CAPTURE.cases[`${network.key}-${kind}`];
      assert.deepEqual(item.request, { address: asset.address, chainId: asset.chainId }, `${network.key} ${kind} request is the pinned asset`);
      assert.equal(item.status, 200);
      assert.equal(typeof parseRelayPrice(item.body, kind), 'number', `${network.key} ${kind} parses within bounds`);
    }
  }
  assert.equal(CAPTURE.cases['unknown-token'].status, 400);
  assert.equal(priceRequest(byKey('solana'), 'native').address, '11111111111111111111111111111111');
  assert.equal(priceRequest(byKey('bsc'), 'native').address, '0x0000000000000000000000000000000000000000');
  assert.equal(priceRequest(byKey('robinhood'), 'funding').symbol, 'USDG');
});

test('a price must be a finite positive number inside its bounds', () => {
  assert.equal(parseRelayPrice({ price: 107.831068 }, 'native'), 107.831068);
  assert.equal(parseRelayPrice({ price: 0.999898 }, 'funding'), 0.999898);
  for (const body of [null, [], 'x', {}, { price: '107.8' }, { price: 0 }, { price: -1 }, { price: Number.NaN }, { price: Number.POSITIVE_INFINITY }, { error: 'Could not get price' }]) {
    assert.equal(parseRelayPrice(body, 'native'), null, JSON.stringify(body));
  }
  // Out of bounds is bad data, omitted rather than clamped.
  assert.equal(parseRelayPrice({ price: PRICE_BOUNDS.native.max * 2 }, 'native'), null);
  assert.equal(parseRelayPrice({ price: 1e-9 }, 'native'), null);
  assert.equal(parseRelayPrice({ price: 2510 }, 'funding'), null, 'an ETH-sized number is never a stablecoin price');
  assert.equal(parseRelayPrice({ price: 0.2 }, 'funding'), null);
});

test('the snapshot has both prices for every network from the capture, read from the fixed Relay endpoint', async () => {
  const { fetch, calls } = replay();
  const time = clock();
  const read = createPriceSource({ fetch, now: time.now, apiKey: () => undefined, cluster: () => 'mainnet-beta' });
  const snapshot = await read();
  assert.equal(snapshot.source, 'Relay');
  assert.equal(snapshot.observedAt, '2026-10-14T05:00:00.000Z');
  assert.deepEqual(snapshot.prices.solana, { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } });
  assert.deepEqual(snapshot.prices.bsc, { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } });
  assert.deepEqual(snapshot.prices.robinhood, { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999881, symbol: 'USDG' } });
  assert.deepEqual(Object.keys(snapshot.prices), ['solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  assert.equal(calls.length, 10);
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${RELAY_PRICE_URL}?`));
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal, 'every read has a timeout');
    assert.equal((call.init.headers as Record<string, string>)['x-api-key'], undefined);
  }
});

test('prices are cached for a minute and concurrent callers share one upstream read', async () => {
  const { fetch, calls } = replay();
  const time = clock();
  const read = createPriceSource({ fetch, now: time.now, apiKey: () => 'relay-key-never-returned', cluster: () => 'mainnet-beta' });
  const [first, second, third] = await Promise.all([read(), read(), read()]);
  assert.equal(calls.length, 10, 'three concurrent callers, one read per asset');
  assert.equal(first, second); assert.equal(second, third);
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'relay-key-never-returned');
  time.advance(59_000);
  assert.equal(await read(), first);
  assert.equal(calls.length, 10);
  time.advance(2_000);
  const fresh = await read();
  assert.equal(calls.length, 20);
  assert.equal(fresh.observedAt, '2026-10-14T05:01:01.000Z');
});

test('a missing, failed, timed-out or out-of-bounds price is omitted, never invented, and retried sooner', async () => {
  const { fetch, calls } = replay({
    'bsc-funding': { status: 400, body: { error: 'Could not get price' } },
    'base-native': new Error('The operation was aborted due to timeout'),
    'robinhood-funding': { status: 200, body: { price: 3.2 } },
    'ethereum-native': { status: 200, body: '<html>busy</html>' },
  });
  const time = clock();
  const read = createPriceSource({ fetch, now: time.now, apiKey: () => undefined, cluster: () => 'mainnet-beta' });
  const snapshot = await read();
  assert.deepEqual(snapshot.prices.bsc, { native: { usd: 744.462048, symbol: 'BNB' } });
  assert.deepEqual(snapshot.prices.base, { funding: { usd: 0.999859, symbol: 'USDC' } });
  assert.deepEqual(snapshot.prices.robinhood, { native: { usd: 2511.149244, symbol: 'ETH' } });
  assert.deepEqual(snapshot.prices.ethereum, { funding: { usd: 0.999859, symbol: 'USDC' } });
  time.advance(16_000);
  await read();
  assert.equal(calls.length, 20, 'a partial snapshot expires after 15 seconds');
});

test('a devnet server never prices Solana', async () => {
  const { fetch, calls } = replay();
  const snapshot = await createPriceSource({ fetch, now: clock().now, apiKey: () => undefined, cluster: () => 'devnet' })();
  assert.equal(snapshot.prices.solana, undefined);
  assert.equal(Object.keys(snapshot.prices).length, 4);
  assert.ok(calls.every(call => new URL(call.url).searchParams.get('chainId') !== '792703809'));
});

function app(options: Parameters<typeof pricesRouter>[0]) {
  const instance = express();
  instance.use('/prices', pricesRouter(options));
  return instance;
}

test('GET /prices answers the snapshot without a session, limited per client IP', async () => {
  const { fetch } = replay();
  const server = app({ fetch, now: clock().now, apiKey: () => 'relay-key-never-returned', cluster: () => 'mainnet-beta', perIpPerMinute: 2 });
  const response = await request(server).get('/prices').expect(200);
  assert.equal(response.body.source, 'Relay');
  assert.equal(response.body.prices.solana.native.usd, 107.831068);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(response.body), /relay-key-never-returned|api\.relay\.link/);
  await request(server).get('/prices').expect(200);
  const limited = await request(server).get('/prices').expect(429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
});

test('GET /prices is 503 when Relay priced nothing, and never echoes the upstream', async () => {
  const fetch = async () => { throw new Error(`connect ECONNREFUSED ${RELAY_PRICE_URL}`); };
  const response = await request(app({ fetch, now: clock().now, apiKey: () => undefined, cluster: () => 'mainnet-beta' })).get('/prices').expect(503);
  assert.deepEqual(response.body, { error: 'Prices are unavailable right now.', source: 'Relay' });
  const broken = await request(app({ read: async () => { throw new Error('boom'); } })).get('/prices').expect(503);
  assert.equal(broken.body.error, 'Prices are unavailable right now.');
});

test('the API server serves /api/solares/wallet/prices before authentication, and balances still need a session', async () => {
  const { fetch } = replay();
  const original = globalThis.fetch;
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  try {
    const { app: server } = await import('../index.js');
    const response = await request(server).get('/api/solares/wallet/prices').expect(200);
    assert.equal(response.body.source, 'Relay');
    assert.equal(typeof response.body.prices.ethereum.native.usd, 'number');
    assert.ok(Number.isFinite(Date.parse(response.body.observedAt)));
    assert.notEqual((await request(server).get('/api/solares/wallet/balances')).status, 200);
    assert.notEqual((await request(server).post('/api/solares/wallet/prices')).status, 200);
  } finally {
    globalThis.fetch = original;
  }
});
