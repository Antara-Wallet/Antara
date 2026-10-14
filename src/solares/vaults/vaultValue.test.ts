import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, parsePriceSnapshot, type PricesState } from '../wallet/prices';
import { VAULT_TOTAL_LABEL, vaultValue } from './vaultValue';

const BODY = {
  prices: {
    solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } },
    bsc: { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    robinhood: { native: { usd: 2511.149244, symbol: 'ETH' } },
  },
  observedAt: '2026-10-14T05:00:52.000Z',
  source: 'Relay',
};
const PRICES: PricesState = { status: 'ready', snapshot: parsePriceSnapshot(BODY) };
const STAMP = `prices from Relay, ${formatClock(BODY.observedAt)}`;

test('the vault headline is its total in US dollars over what it holds', () => {
  // 0.005 SOL at $107.831068 and 0 USDC.
  const model = vaultValue({ chain: 'solana', native: 5_000_000n, stablecoin: 0n, prices: PRICES, privacy: false });
  assert.equal(model.label, VAULT_TOTAL_LABEL);
  assert.equal(model.label, 'Vault · total');
  assert.deepEqual(model.headline, { kind: 'usd', amount: '$0.54', approx: true });
  assert.equal(model.holdings, '0.005 SOL · 0 USDC');
  assert.deepEqual(model.holdingList, ['0.005 SOL', '0 USDC']);
  assert.equal(model.source, STAMP);
  assert.equal(model.excluded, '');
  assert.match(model.title!, /Estimated value in US dollars/);
});

test('Binance-Peg USDC at 18 decimals adds to BNB exactly', () => {
  const model = vaultValue({ chain: 'bsc', native: 250_000_000_000_000_000n, stablecoin: 1_500_000_000_000_000_000n, prices: PRICES, privacy: false });
  assert.deepEqual(model.headline, { kind: 'usd', amount: '$187.62', approx: true });
  assert.equal(model.holdings, '0.25 BNB · 1.5 USDC (Binance-Peg)');
});

test('an unpriced stablecoin is excluded by name; no price at all leads with the largest holding, never $0', () => {
  const robinhood = vaultValue({ chain: 'robinhood', native: 10_000_000_000_000_000n, stablecoin: 2_500_000n, prices: PRICES, privacy: false });
  assert.deepEqual(robinhood.headline, { kind: 'usd', amount: '$25.11', approx: true });
  assert.equal(robinhood.excluded, 'Excludes 2.5 USDG (no price)');
  const none = vaultValue({ chain: 'solana', native: 5_000_000n, stablecoin: 0n, prices: { status: 'unavailable' }, privacy: false });
  assert.deepEqual(none.headline, { kind: 'amount', amount: '0.005', unit: 'SOL' });
  assert.equal(none.source, 'USD value unavailable');
  const loading = vaultValue({ chain: 'solana', native: 5_000_000n, stablecoin: 0n, prices: { status: 'loading' }, privacy: false });
  assert.deepEqual(loading.headline, { kind: 'pending', reason: 'Reading prices' });
});

test('an empty vault is an exact $0.00; devnet has no USDC and no price', () => {
  const empty = vaultValue({ chain: 'solana', native: 0n, stablecoin: 0n, prices: { status: 'unavailable' }, privacy: false });
  assert.deepEqual(empty.headline, { kind: 'usd', amount: '$0.00', approx: false });
  assert.equal(empty.source, '');
  const devnet = vaultValue({ chain: 'solana', native: 1_000_000_000n, stablecoin: null, prices: PRICES, privacy: false, cluster: 'devnet' });
  assert.deepEqual(devnet.headline, { kind: 'amount', amount: '1', unit: 'SOL' });
  assert.equal(devnet.holdings, '1 SOL');
});

test('privacy masks the total and the holdings', () => {
  const model = vaultValue({ chain: 'robinhood', native: 10_000_000_000_000_000n, stablecoin: 2_500_000n, prices: PRICES, privacy: true });
  assert.deepEqual(model.headline, { kind: 'masked' });
  assert.equal(model.holdings, '••••••');
  assert.deepEqual(model.holdingList, []);
  assert.equal(model.excluded, 'Excludes USDG (no price)');
  assert.equal(model.title, undefined);
});
