import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { PrivyClient } from '@privy-io/node';
import { app, redactError } from '../index.js';

test('health and readiness disclose capabilities without secrets', async () => {
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.build, 'antara-2026-10-12');
  assert.equal(health.body.primaryChain, 'solana');
  assert.deepEqual(health.body.chains, ['solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  const walletConfig = await request(app).get('/api/solares/wallet/config');
  assert.equal(walletConfig.body.primaryChain, 'solana');
  assert.deepEqual(walletConfig.body.chains, health.body.chains);
  const readiness = await request(app).get('/api/solares/relay/config');
  assert.equal(readiness.status, 200);
  assert.equal(typeof readiness.body.configured, 'boolean');
  assert.equal(readiness.body.apiKey, undefined);
  assert.equal(readiness.headers['x-content-type-options'], 'nosniff');
  assert.equal(readiness.headers['x-frame-options'], 'DENY');
  assert.match(readiness.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('wallet config lists the five networks with pinned stablecoins and reports RPC configuration as booleans only', async () => {
  const names = ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.ROBINHOOD_RPC_URL = 'https://rpc.provider.dev/v2/config-secret-41ab';
  process.env.ETHEREUM_RPC_URL = '   ';
  try {
    const { body } = await request(app).get('/api/solares/wallet/config').expect(200);
    assert.doesNotMatch(JSON.stringify(body), /config-secret|rpc\.provider|https?:/);
    assert.deepEqual(body.networks.map((network: { key: string; relayChainId: number; evmChainId: number | null; rpcConfigured: boolean }) => [network.key, network.relayChainId, network.evmChainId, network.rpcConfigured]), [
      ['solana', 792703809, null, false], ['ethereum', 1, 1, false], ['bsc', 56, 56, false], ['robinhood', 4663, 4663, true], ['base', 8453, 8453, false],
    ]);
    assert.deepEqual(body.networks.map((network: { funding: { symbol: string; label: string; decimals: number; circleIssued: boolean } }) => [network.funding.symbol, network.funding.label, network.funding.decimals, network.funding.circleIssued]), [
      ['USDC', 'USDC', 6, true], ['USDC', 'USDC', 6, true], ['USDC', 'USDC (Binance-Peg)', 18, false], ['USDG', 'USDG', 6, false], ['USDC', 'USDC', 6, true],
    ]);
    assert.deepEqual(body.networks.map((network: { native: { symbol: string } }) => network.native.symbol), ['SOL', 'ETH', 'BNB', 'ETH', 'ETH']);
    assert.equal(body.ethereumRpcConfigured, false); assert.equal(body.solanaRpcConfigured, false);
    assert.ok(!JSON.stringify(body).match(/arbitrum|polygon/i), 'removed networks are not advertised');
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('an override that repeats a public RPC or is malformed is not reported as a dedicated RPC', async () => {
  const names = ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const configured = async () => {
    const { body } = await request(app).get('/api/solares/wallet/config').expect(200);
    return Object.fromEntries(body.networks.map((network: { key: string; rpcConfigured: boolean }) => [network.key, network.rpcConfigured]));
  };
  try {
    // The registry's public endpoints, in any spelling, are still the rate-limited public RPC.
    process.env.SOLANA_RPC_URL = ' https://API.mainnet-beta.solana.com/ ';
    process.env.ETHEREUM_RPC_URL = 'https://ethereum-rpc.publicnode.com';
    process.env.BSC_RPC_URL = 'https://bsc-rpc.publicnode.com/';
    process.env.ROBINHOOD_RPC_URL = 'https://robinhood-rpc.publicnode.com';
    process.env.BASE_RPC_URL = 'https://mainnet.base.org';
    assert.deepEqual(await configured(), { solana: false, ethereum: false, bsc: false, robinhood: false, base: false });
    // The browser's keyless Solana default is public too.
    process.env.SOLANA_RPC_URL = 'https://solana-rpc.publicnode.com/';
    assert.equal((await configured()).solana, false);
    process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
    // Malformed overrides make every read fail, so they never count as configured either.
    process.env.ETHEREUM_RPC_URL = 'not a url';
    process.env.BSC_RPC_URL = 'wss://bsc.provider.dev/v2/config-secret-41ab';
    process.env.ROBINHOOD_RPC_URL = 'https://rpc.provider.dev/v2/config-secret-41ab';
    process.env.BASE_RPC_URL = 'https://base.provider.dev/v2/config-secret-41ab';
    const { body } = await request(app).get('/api/solares/wallet/config').expect(200);
    assert.doesNotMatch(JSON.stringify(body), /config-secret|provider\.dev|not a url/);
    assert.deepEqual(await configured(), { solana: false, ethereum: false, bsc: false, robinhood: true, base: true });
    assert.equal(body.solanaRpcConfigured, false); assert.equal(body.ethereumRpcConfigured, false);
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

// The legacy gate prefers ANTARA_ENABLE_LEGACY_API, then AETHRA_, then SOLARES_.
// Clearing the preferred names keeps a local server/.env from deciding these tests.
function legacyApi(value: 'true' | 'false') {
  delete process.env.ANTARA_ENABLE_LEGACY_API; delete process.env.AETHRA_ENABLE_LEGACY_API;
  process.env.SOLARES_ENABLE_LEGACY_API = value;
}

test('legacy writes cannot bypass the Privy authorization boundary', async () => {
  legacyApi('false');
  for (const path of ['/vault/cosign', '/vault/policy', '/vault/webauthn/register/options', '/tx/broadcast', '/admin/clear-credentials']) {
    const response = await request(app).post(path).send({ factors: { webauthn: { verified: true } } });
    assert.equal(response.status, 403, path);
    assert.match(response.body.error, /disabled/);
  }
});

test('wallet and Relay data require an authenticated session', async () => {
  const saved = { app: process.env.PRIVY_APP_ID, secret: process.env.PRIVY_APP_SECRET };
  process.env.PRIVY_APP_ID = 'test-app'; process.env.PRIVY_APP_SECRET = 'test-secret';
  try {
    for (const path of ['/api/solares/wallet/balances', '/api/solares/relay/chains', '/api/solares/relay/status/0xdeadbeef']) {
      assert.equal((await request(app).get(path)).status, 401);
    }
    assert.equal((await request(app).post('/api/solares/relay/quote').send({ userId: 'forged' })).status, 401);
  } finally {
    if (saved.app === undefined) delete process.env.PRIVY_APP_ID; else process.env.PRIVY_APP_ID = saved.app;
    if (saved.secret === undefined) delete process.env.PRIVY_APP_SECRET; else process.env.PRIVY_APP_SECRET = saved.secret;
  }
});

test('malformed and oversized requests are rejected without echoing content', async () => {
  const malformed = await request(app).post('/api/solares/relay/quote').set('Content-Type', 'application/json').send('{sensitive-broken');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'Invalid JSON request');
  const large = await request(app).post('/api/solares/relay/quote').send({ data: 'x'.repeat(270_000) });
  assert.equal(large.status, 413);
});

test('HEAD probes are safe methods, not legacy mutations', async () => {
  legacyApi('false');
  const head = await request(app).head('/health');
  assert.equal(head.status, 200);
  for (const path of ['/', '/vault/policy', '/missing-route']) assert.notEqual((await request(app).head(path)).status, 403, path);
  assert.equal((await request(app).post('/health')).status, 403);
});

test('provider errors never echo credential-bearing RPC URLs to clients or logs', async (t) => {
  const secret = 'test-secret-7f3a9c1d';
  const leaked = `https://base-mainnet.g.alchemy.com/v2/${secret}`;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).includes('llama.fi')) throw new TypeError(`fetch failed: ${leaked}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `rejected ${leaked}` } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const logs: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const address = '0x1111111111111111111111111111111111111111';
  for (const path of [`/tx/params?chain=base&from=${address}&to=${address}`, `/vault/deployed?chain=base&address=${address}`, '/prices?ids=coingecko:ethereum', `/token/base/${address}`]) {
    const response = await request(app).get(path);
    assert.ok(response.status >= 400, path);
    assert.equal(typeof response.body.error, 'string', path);
    assert.doesNotMatch(JSON.stringify(response.body), /alchemy|llama|https?:|\/v2\/|test-secret/i, path);
  }
  assert.equal(logs.length, 4);
  for (const line of logs) assert.doesNotMatch(line, /https?:|test-secret/);
  const redacted = redactError(new Error(`HTTP request failed.\nURL: ${leaked}\nDetails: base-mainnet.g.alchemy.com/v2/${secret}`));
  assert.doesNotMatch(redacted, /test-secret|https?:|\n/);
});

test('redaction is bounded before any regex runs, even when the error echoes a 256 KB request body', () => {
  // viem's RpcRequestError embeds the request body; a raw tx near the body limit
  // previously made the URL pattern backtrack quadratically (seconds per request).
  const key = 'bounded-key-4e1f';
  for (const message of [`URL: https://x.g.alchemy.com/v2/${key}\nRequest body: 0x${'ab'.repeat(128_000)}`, `rejected${' '.repeat(256_000)}x\n https://x.g.alchemy.com/v2/${key}`]) {
    const started = performance.now();
    const redacted = redactError(new Error(message));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `redaction took ${elapsed.toFixed(1)}ms`);
    assert.ok(redacted.length <= 300);
    assert.doesNotMatch(redacted, new RegExp(`${key}|https?:`));
  }
});

test('legacy swap routes reject caller mistakes as 400s before any provider call', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('no network in tests'); });
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const cases: Array<[string, RegExp]> = [
    [`tokenIn=native&tokenOut=${usdc}&amountIn=0`, /^amountIn must be > 0$/],
    [`tokenIn=native&tokenOut=${usdc}&amountIn=-1`, /^amountIn must be > 0$/],
    [`tokenIn=${usdc}&tokenOut=${usdc.toLowerCase()}&amountIn=1`, /^tokenIn and tokenOut resolve to the same token$/],
    [`tokenIn=not-a-token&tokenOut=${usdc}&amountIn=1`, /^tokenIn and tokenOut must be token addresses or "native"$/],
  ];
  for (const [query, error] of cases) {
    const response = await request(app).get(`/swap/quote?chain=base&${query}`).expect(400);
    assert.match(response.body.error, error, query);
  }
  // Removed networks, and networks without pinned legacy swap data, fail closed before any provider call.
  for (const chain of ['polygon', 'arbitrum', 'bsc', 'robinhood', 'solana']) {
    const response = await request(app).get(`/swap/quote?chain=${chain}&tokenIn=native&tokenOut=${usdc}&amountIn=1`).expect(400);
    assert.equal(response.body.error, 'invalid chain', chain);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('authenticated balances cover all five networks in order and report unreachable RPCs as failures, never zero', async (t) => {
  const saved = { app: process.env.PRIVY_APP_ID, secret: process.env.PRIVY_APP_SECRET, base: process.env.BASE_RPC_URL };
  process.env.PRIVY_APP_ID = 'test-app'; process.env.PRIVY_APP_SECRET = 'test-secret';
  process.env.BASE_RPC_URL = 'https://rpc.provider.dev/v2/balance-secret-0d3e';
  t.after(() => {
    for (const [name, value] of [['PRIVY_APP_ID', saved.app], ['PRIVY_APP_SECRET', saved.secret], ['BASE_RPC_URL', saved.base]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const evm = '0x1111111111111111111111111111111111111111';
  const solana = 'BalanceRouteOwner11111111111111111111111111';
  t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => ({ user_id: 'did:privy:networks' }) }) }));
  t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => ({ id, linked_accounts: [{ type: 'wallet', chain_type: 'ethereum', address: evm }, { type: 'wallet', chain_type: 'solana', address: solana }] }) }));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('no network in tests'); });
  const response = await request(app).get('/api/solares/wallet/balances').query({ solana, ethereum: evm.toUpperCase().replace('0X', '0x') }).set('Authorization', 'Bearer test-token').expect(200);
  assert.deepEqual(response.body.balances, []);
  assert.deepEqual(response.body.failures, ['solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  assert.doesNotMatch(JSON.stringify(response.body), /balance-secret|rpc\.provider|https?:/);
  // Another wallet is refused before any RPC read.
  await request(app).get('/api/solares/wallet/balances').query({ ethereum: '0x2222222222222222222222222222222222222222' }).set('Authorization', 'Bearer test-token').expect(403);
});
