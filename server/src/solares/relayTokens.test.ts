import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import express from 'express';
import request from 'supertest';
import { PrivyClient } from '@privy-io/node';
import { RELAY_NETWORKS, fundingToken, nativeToken, tokenFor, tradeNetwork, type TradeIntent, type TradeToken } from '../../../src/solares/relay/model';
import { validateIntent, verifyReviewedQuote } from '../../../src/solares/relay/validation';
import { parseCurrencies, pinnedCurrency, sameTokenSymbol, tokenLookupRequests } from '../../../src/solares/relay/currencies';
import relayRouter, { verifyDestinationToken } from './relay';

// Live responses from Relay's public currency API, captured read-only on 2026-10-13
// (fixtures/relay-currencies/README.md). Each lookup is answered only from a capture whose request
// body is identical; any other request fails the test.
type Capture = { request: Record<string, unknown>; status: number; body: Array<Record<string, unknown>> };
const CURRENCIES = JSON.parse(readFileSync(new URL('./fixtures/relay-currencies/currencies.json', import.meta.url), 'utf8')) as { cases: Record<string, Capture> };
const capture = (name: string) => { const item = CURRENCIES.cases[name]; assert.ok(item, name); return item; };
const ORDERS = new URL('./fixtures/relay-orders/', import.meta.url);
const orders = JSON.parse(readFileSync(new URL('manifest.json', ORDERS), 'utf8')) as {
  routes: Record<string, { file: string; receivedAt: number; intent: TradeIntent }>; placeholders: { evm: string; solana: string };
};
const chainsFixture = readFileSync(new URL('chains.json', ORDERS), 'utf8');
const ROBINHOOD = 4663, BASE = 8453, SOLANA = 792703809;
const EVM = '0x1111111111111111111111111111111111111111';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c';
const BOMI = '0x46d8f8ba030c1d09ae17d2b5107dfef4b331fe0d', BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const robinhood = tradeNetwork(ROBINHOOD);

function lookupOf(name: string): Record<string, unknown> { return capture(name).request; }
/** The picker's view of a captured entry: only the fields `parseCurrencies` keeps. */
function picked(name: string, address: string): TradeToken {
  const chainId = (capture(name).request.chainIds as number[])[0];
  const token = parseCurrencies(capture(name).body, chainId).find(item => item.address.toLowerCase() === address.toLowerCase());
  assert.ok(token, `${name} lists ${address}`);
  return token;
}
function intentTo(destinationChainId: number, destinationToken: TradeIntent['destinationToken']): TradeIntent {
  const network = tradeNetwork(destinationChainId);
  const wallet = network.vm === 'solana' ? orders.placeholders.solana : EVM;
  return { originChainId: destinationChainId, destinationChainId, user: wallet, recipient: wallet, amount: (10n ** BigInt(network.funding.decimals)).toString(), destinationToken, slippageBps: 50 };
}
/** Replays captured /currencies/v2 responses and records every request body in order. */
function replay(t: TestContext) {
  const lookups: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.relay.link/currencies/v2');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    lookups.push(body);
    const hit = Object.values(CURRENCIES.cases).find(item => isDeepStrictEqual(item.request, body));
    if (!hit) throw new Error(`No captured Relay response for ${JSON.stringify(body)}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  });
  return lookups;
}

test('captured Relay metadata: external search renames Robinhood Chain ETH and changes ticker case', () => {
  const symbols = (name: string) => capture(name).body.map(entry => entry.symbol);
  // The old check asked external search only and compared tickers exactly, so every one of these failed.
  assert.deepEqual(symbols('rh-native-ext-on'), ['WETH']);
  assert.deepEqual(symbols('rh-native-ext-off'), ['ETH']);
  assert.deepEqual([symbols('rh-nvda-ext-off'), symbols('rh-nvda-ext-on')], [['nvda'], ['NVDA']]);
  assert.deepEqual([symbols('rh-spy-ext-off'), symbols('rh-spy-ext-on')], [['spy'], ['SPY']]);
  assert.deepEqual([symbols('sol-bonk-ext-off'), symbols('sol-bonk-ext-on')], [['BONK'], ['Bonk']]);
  assert.deepEqual([symbols('base-bomi-ext-off'), symbols('base-bomi-ext-on')], [[], ['BOMI']]);
  // The picker's default list shows the lower-case stock tickers.
  assert.equal(picked('rh-default-list', NVDA).symbol, 'nvda');
  assert.equal(picked('rh-default-list', SPY).symbol, 'spy');
  // "WETH" at the native address can never pass as Robinhood Chain's pinned ETH.
  assert.deepEqual(parseCurrencies(capture('rh-native-ext-on').body, ROBINHOOD), []);
  assert.deepEqual(parseCurrencies(capture('rh-native-ext-off').body, ROBINHOOD).map(item => [item.symbol, item.decimals]), [['ETH', 18]]);
  assert.deepEqual(tokenLookupRequests(picked('rh-default-list', NVDA)), [lookupOf('rh-nvda-ext-off'), lookupOf('rh-nvda-ext-on')]);
  assert.ok(sameTokenSymbol('nvda', 'NVDA') && sameTokenSymbol('Bonk', 'BONK') && !sameTokenSymbol('WETH', 'ETH'));
});

test('Robinhood Chain ETH and every network\'s pinned coin and stablecoin verify from the registry, with no lookup', async (t) => {
  const lookups = replay(t);
  // The object form the swap screen sends for Robinhood Chain ETH is a valid intent and passes the token check.
  const ethIntent = intentTo(ROBINHOOD, tokenFor(robinhood, 'native'));
  validateIntent(ethIntent);
  await verifyDestinationToken(ethIntent);
  await verifyDestinationToken(intentTo(ROBINHOOD, 'native'));
  for (const network of RELAY_NETWORKS) {
    for (const token of [nativeToken(network), fundingToken(network)]) {
      assert.deepEqual(pinnedCurrency(network.id, token.address), token);
      await verifyDestinationToken({ ...intentTo(network.id, token), originChainId: BASE });
    }
  }
  assert.deepEqual(lookups, []);
  // Pinned metadata is exact: a provider-style "WETH", other decimals or another chain id fail closed, still without a lookup.
  const eth = nativeToken(robinhood);
  for (const spoof of [{ ...eth, symbol: 'WETH' }, { ...eth, symbol: 'eth' }, { ...eth, decimals: 6 }, { ...eth, chainId: BASE }, { ...fundingToken(robinhood), decimals: 18 }]) {
    await assert.rejects(verifyDestinationToken(intentTo(ROBINHOOD, spoof)), /metadata changed/, JSON.stringify(spoof));
  }
  assert.deepEqual(lookups, []);
});

test('Robinhood Chain stock tokens and Solana BONK verify from Relay\'s own list whatever the ticker case', async (t) => {
  const lookups = replay(t);
  const nvda = picked('rh-default-list', NVDA), spy = picked('rh-default-list', SPY);
  const nvdaExternal = picked('rh-nvda-ext-on', NVDA), bonkExternal = picked('sol-bonk-ext-on', BONK);
  for (const [token, lookup] of [
    [nvda, 'rh-nvda-ext-off'], [nvdaExternal, 'rh-nvda-ext-off'], [spy, 'rh-spy-ext-off'],
    [{ ...spy, symbol: 'SPY' }, 'rh-spy-ext-off'], [picked('sol-bonk-ext-off', BONK), 'sol-bonk-ext-off'], [bonkExternal, 'sol-bonk-ext-off'],
  ] as const) {
    lookups.length = 0;
    const intent = intentTo(token.chainId, token);
    validateIntent(intent);
    await verifyDestinationToken(intent);
    assert.deepEqual(lookups, [lookupOf(lookup)], `${token.symbol} resolves on Relay's own list`);
  }
});

test('a token only external search knows verifies on the second lookup', async (t) => {
  const lookups = replay(t);
  const bomi = picked('base-bomi-ext-on', BOMI);
  await verifyDestinationToken(intentTo(BASE, bomi));
  assert.deepEqual(lookups, [lookupOf('base-bomi-ext-off'), lookupOf('base-bomi-ext-on')]);
});

test('chain, address and decimals stay exact; the first source that knows the address decides the ticker', async (t) => {
  const lookups = replay(t);
  const nvda = picked('rh-default-list', NVDA), bomi = picked('base-bomi-ext-on', BOMI);
  // Relay's own list disagrees on decimals: rejected at once, external search is not asked to overrule it.
  await assert.rejects(verifyDestinationToken(intentTo(ROBINHOOD, { ...nvda, decimals: 6 })), /metadata changed/);
  assert.deepEqual(lookups, [lookupOf('rh-nvda-ext-off')]);
  lookups.length = 0;
  // Another ticker than Relay's own list uses: rejected there, external search can never overrule the label.
  await assert.rejects(verifyDestinationToken(intentTo(ROBINHOOD, { ...nvda, symbol: 'AAPL' })), /metadata changed/);
  assert.deepEqual(lookups, [lookupOf('rh-nvda-ext-off')]);
  lookups.length = 0;
  // Only a token Relay's own list does not know is decided by external search.
  await assert.rejects(verifyDestinationToken(intentTo(BASE, { ...bomi, symbol: 'AAPL' })), /metadata changed/);
  assert.deepEqual(lookups, [lookupOf('base-bomi-ext-off'), lookupOf('base-bomi-ext-on')]);
  lookups.length = 0;
  await assert.rejects(verifyDestinationToken(intentTo(BASE, { ...bomi, decimals: 6 })), /metadata changed/);
  assert.deepEqual(lookups, [lookupOf('base-bomi-ext-off'), lookupOf('base-bomi-ext-on')]);
  lookups.length = 0;
  // A token object for another chain never reaches Relay.
  await assert.rejects(verifyDestinationToken(intentTo(ROBINHOOD, { ...nvda, chainId: BASE })), /metadata changed/);
  await assert.rejects(verifyDestinationToken({ ...intentTo(ROBINHOOD, nvda), destinationChainId: SOLANA }), /metadata changed/);
  assert.deepEqual(lookups, []);
});

test('an unknown token, or an unavailable lookup, fails closed without falling through', async (t) => {
  const token: TradeToken = { chainId: BASE, address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test token', decimals: 18 };
  const bodies: Record<string, unknown>[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(status === 200 ? '[]' : '{}', { status });
  });
  await assert.rejects(verifyDestinationToken(intentTo(BASE, token)), /metadata changed/);
  assert.deepEqual(bodies, tokenLookupRequests(token));
  for (const [code, message] of [[500, /temporarily unavailable/], [429, /busy/]] as const) {
    bodies.length = 0; status = code;
    await assert.rejects(verifyDestinationToken(intentTo(BASE, token)), message);
    assert.equal(bodies.length, 1, `${code} stops at the first lookup`);
  }
});

// /quote with real captures: Privy, the clock and Relay's HTTP API are mocked; nothing leaves the process.
function quoteApp(t: TestContext, userId: string, route: string) {
  const { file, receivedAt } = orders.routes[route];
  const quote = readFileSync(new URL(file, ORDERS), 'utf8');
  const saved = new Map(['RELAY_API_KEY', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, { RELAY_API_KEY: 'relay-test-key', PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'test-secret' });
  t.mock.timers.enable({ apis: ['Date'], now: receivedAt });
  t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => ({ user_id: userId }) }) }));
  t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => ({ id, mfa_methods: [], linked_accounts: [
    { type: 'wallet', chain_type: 'solana', address: orders.placeholders.solana, connector_type: 'embedded', wallet_client_type: 'privy' },
    { type: 'wallet', chain_type: 'ethereum', address: orders.placeholders.evm, connector_type: 'embedded', wallet_client_type: 'privy' },
  ] }) }));
  const paths: string[] = [], lookups: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/chains') return new Response(chainsFixture, { status: 200 });
    if (path === '/quote/v2') return new Response(quote, { status: 200 });
    if (path === '/currencies/v2') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      lookups.push(body);
      const hit = Object.values(CURRENCIES.cases).find(item => isDeepStrictEqual(item.request, body));
      return hit ? new Response(JSON.stringify(hit.body), { status: hit.status }) : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/relay', relayRouter);
  const post = (body: unknown) => request(app).post('/relay/quote').set('Authorization', 'Bearer test-token').send(body as object);
  return { post, paths, lookups, now: receivedAt, intent: structuredClone(orders.routes[route].intent) };
}

test('/quote accepts Robinhood Chain USDG to ETH as the swap screen sends it, without asking Relay about ETH', async (t) => {
  const { post, paths, now, intent } = quoteApp(t, 'did:privy:relay-tokens-robinhood-eth', 'robinhood-usdg-to-robinhood-eth');
  const sent = { ...intent, destinationToken: tokenFor(robinhood, 'native') };
  const response = await post(sent);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(paths.includes('/quote/v2') && !paths.includes('/currencies/v2'), paths.join());
  await verifyReviewedQuote(response.body, sent, now);
});

test('/quote accepts captured custom-token routes after one lookup on Relay\'s own list', async (t) => {
  for (const [route, lookup] of [['solana-usdc-to-solana-bonk', 'sol-bonk-ext-off'], ['base-usdc-to-base-aero', 'base-aero-ext-off']] as const) {
    const { post, paths, lookups, now, intent } = quoteApp(t, `did:privy:relay-tokens-${route}`, route);
    const response = await post(intent);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(lookups, [lookupOf(lookup)], route);
    assert.ok(paths.includes('/quote/v2'), route);
    await verifyReviewedQuote(response.body, intent, now);
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});
