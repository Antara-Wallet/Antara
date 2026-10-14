import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PrivyClient } from '@privy-io/node';

// Providers read their configuration when the server modules load. node:test runs
// each file in its own process, so this file configures them before importing.
const dataDir = mkdtempSync(join(tmpdir(), 'antara-api-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  GMGN_API_KEY: 'test-gmgn-key',
  ALCHEMY_API_KEY: 'test-alchemy-key-31c0',
  RELAY_API_KEY: 'relay-secret-5c2e8b',
  BASE_RPC_URL: 'https://rpc.example.test/path-secret-9d41?apikey=query-secret-77ab',
  PRIVY_APP_ID: 'test-app',
  PRIVY_APP_SECRET: 'test-privy-secret',
});
writeFileSync(join(dataDir, 'stealth-announcements.json'), JSON.stringify({
  seq: 3,
  items: [1, 2, 3].map(id => ({ id, chain: 'base', stealthAddress: `0x${String(id).repeat(40)}`, ephemeralPub: `0x02${'ab'.repeat(32)}`, viewTag: id, ts: 0 })),
}));
const { app, redactError } = await import('../index.js');
const { cache } = await import('../cache.js');
const { getPrices } = await import('../providers/defillama.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('trench limits are clamped before reaching the upstream body or the shared cache', async (t) => {
  const forwarded: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    forwarded.push(JSON.parse(String(init?.body)).new_creation.limit);
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  });
  const before = cache.size;
  for (const limit of ['1000000', '1e9', '-5', '0', 'NaN', 'Infinity', '61', '60.9', 'abc']) {
    await request(app).get(`/trenches/base?limit=${limit}`).expect(200);
    await request(app).get(`/trenches/base?limit=${limit}&type=new_creation`).expect(200);
  }
  assert.ok(cache.size - before <= 2, 'arbitrary limits must not create unbounded cache keys');
  // GMGN is configured in this process, so the upstream body is really built and inspected.
  assert.deepEqual([...forwarded].sort((a, b) => a - b), [1, 60]);
});

test('balance refreshes are limited per account before RPC reads, and per IP before Privy calls', async (t) => {
  const solana = 'SoLimitTestOwner1111111111111111111111111111';
  let privyCalls = 0;
  t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => { privyCalls += 1; return { user_id: 'did:privy:limits' }; } }) }));
  t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => ({ id, linked_accounts: [{ type: 'wallet', chain_type: 'solana', address: solana }] }) }));
  const rpc = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('no network in tests'); });
  const balances = () => request(app).get('/api/solares/wallet/balances').query({ solana }).set('Authorization', 'Bearer test-token');
  for (let i = 0; i < 30; i++) {
    const response = await balances().expect(200);
    // An unreachable RPC is reported as a failure, never as a zero balance.
    assert.deepEqual(response.body.balances, []); assert.deepEqual(response.body.failures, ['solana']);
  }
  const reads = rpc.mock.callCount();
  assert.ok(reads >= 30);
  const limited = await balances().expect(429);
  assert.equal(limited.body.code, 'RATE_LIMITED'); assert.equal(limited.headers['retry-after'], '60');
  assert.equal(rpc.mock.callCount(), reads, 'a limited request must not read balances');
  assert.equal(privyCalls, 31);
  // The coarse per-IP limit (120/min) stops further Privy verification entirely.
  for (let i = 31; i < 120; i++) await balances().expect(429);
  assert.equal(privyCalls, 120);
  await balances().expect(429);
  assert.equal(privyCalls, 120);
  assert.equal(rpc.mock.callCount(), reads);
});

test('provider "no route" stays recognisable to the desktop swap screen; other text stays generic', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('no network in tests'); });
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const quote = await request(app).get(`/swap/quote?chain=base&tokenIn=native&tokenOut=${usdc}&amountIn=1000`).expect(502);
  assert.equal(quote.body.error, 'no route found for this pair');
  // The gate prefers ANTARA_, then AETHRA_, then SOLARES_ENABLE_LEGACY_API; clear the
  // preferred names so a local server/.env cannot decide this test, then restore them.
  const names = ['ANTARA_ENABLE_LEGACY_API', 'AETHRA_ENABLE_LEGACY_API', 'SOLARES_ENABLE_LEGACY_API'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  delete process.env.ANTARA_ENABLE_LEGACY_API; delete process.env.AETHRA_ENABLE_LEGACY_API;
  process.env.SOLARES_ENABLE_LEGACY_API = 'true';
  try {
    const build = await request(app).post('/swap/build').send({ chain: 'base', tokenIn: 'native', tokenOut: usdc, amountIn: '1000', recipient: '0x1111111111111111111111111111111111111111' }).expect(502);
    assert.equal(build.body.error, 'no route found for this pair');
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('log redaction also removes configured service secrets and RPC URL path and query parts', () => {
  const redacted = redactError(new Error('rejected rpc.example.test/path-secret-9d41 (apikey=query-secret-77ab) relay-secret-5c2e8b test-privy-secret test-alchemy-key-31c0'));
  assert.doesNotMatch(redacted, /path-secret|query-secret|relay-secret|test-privy-secret|test-alchemy-key/);
});

test('announcement cursors and limits are clamped to safe integers', async () => {
  const ids = async (query: string) => {
    const response = await request(app).get(`/stealth/announcements?chain=base&${query}`).expect(200);
    return (response.body.items as Array<{ id: number }>).map(item => item.id);
  };
  assert.deepEqual(await ids('limit=-5'), [1]);
  assert.deepEqual(await ids('limit=0'), [1]);
  assert.deepEqual(await ids('limit=2'), [1, 2]);
  assert.deepEqual(await ids('limit=1e9'), [1, 2, 3]);
  assert.deepEqual(await ids('limit=abc'), [1, 2, 3]);
  assert.deepEqual(await ids('since=-10&limit=1'), [1]);
  assert.deepEqual(await ids('since=abc'), [1, 2, 3]);
  assert.deepEqual(await ids('since=2'), [3]);
});

test('per-id price memory keeps at most 5,000 ids and evicts the oldest first', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const ids = decodeURIComponent(String(url).split('/').pop() ?? '').split(',');
    return new Response(JSON.stringify({ coins: Object.fromEntries(ids.map(id => [id, { price: 1 }])) }), { status: 200 });
  });
  const ids = Array.from({ length: 5_001 }, (_, i) => `coingecko:bound-test-${i}`);
  assert.equal(Object.keys(await getPrices(ids)).length, 5_001);
  assert.equal(upstream.mock.callCount(), 1);
  await getPrices([ids[1], ids[5_000]]);
  assert.equal(upstream.mock.callCount(), 1, 'the newest 5,000 ids are served from memory');
  await getPrices([ids[0]]);
  assert.equal(upstream.mock.callCount(), 2, 'the oldest id was evicted at capacity');
});
