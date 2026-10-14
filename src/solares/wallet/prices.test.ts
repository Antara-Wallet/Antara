import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approxUsd, byAmount, compactAmount, decimalPrice, excludedNote, formatClock, formatPrice, formatUsd, parsePriceSnapshot, priceFor, priceStamp, usdHeadline,
  usdDisplay, usdValue, valuate, valuationTitle, type Holding, type PricesState,
} from './prices';

/** The API's answer with the prices Relay returned on 2026-10-14 (server/src/solares/fixtures/relay-prices). */
const PRICES_BODY = {
  prices: {
    solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } },
    ethereum: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    bsc: { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    robinhood: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999881, symbol: 'USDG' } },
    base: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
  },
  observedAt: '2026-10-14T05:00:52.000Z',
  source: 'Relay',
};
const READY: PricesState = { status: 'ready', snapshot: parsePriceSnapshot(PRICES_BODY) };
const USD = (dollars: string) => {
  const [whole, fraction = ''] = dollars.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
};
const hold = (chain: Holding['chain'], kind: Holding['kind'], raw: bigint, decimals: number, label: string): Holding => ({ chain, kind, raw, decimals, label });

test('a JavaScript number becomes an exact decimal, exponents included', () => {
  assert.deepEqual(decimalPrice(107.831068), { units: 107831068n, scale: 6 });
  assert.deepEqual(decimalPrice(0.999898), { units: 999898n, scale: 6 });
  assert.deepEqual(decimalPrice(2511), { units: 2511n, scale: 0 });
  assert.deepEqual(decimalPrice(1e-7), { units: 1n, scale: 7 });
  assert.deepEqual(decimalPrice(1.5e-7), { units: 15n, scale: 8 });
  assert.deepEqual(decimalPrice(1e21), { units: 10n ** 21n, scale: 0 });
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.5', null]) assert.equal(decimalPrice(value), null, String(value));
});

test('the API snapshot is parsed strictly; a bad entry is dropped, never repaired', () => {
  const snapshot = parsePriceSnapshot(PRICES_BODY);
  assert.equal(snapshot.source, 'Relay');
  assert.equal(snapshot.observedAt, '2026-10-14T05:00:52.000Z');
  assert.deepEqual(snapshot.table.solana?.native, { units: 107831068n, scale: 6, symbol: 'SOL' });
  assert.deepEqual(snapshot.table.robinhood?.stablecoin, { units: 999881n, scale: 6, symbol: 'USDG' });
  const odd = parsePriceSnapshot({
    ...PRICES_BODY,
    prices: {
      solana: { native: { usd: 107.8, symbol: 'ETH' }, funding: { usd: 0.9999, symbol: 'USDC' } },
      robinhood: { funding: { usd: 0.9999, symbol: 'USDC' } },
      bsc: { native: { usd: '744', symbol: 'BNB' }, funding: { usd: 2511, symbol: 'USDC' } },
      base: { native: { usd: 1e9, symbol: 'ETH' } },
      arbitrum: { native: { usd: 2511, symbol: 'ETH' } },
    },
  });
  assert.deepEqual(Object.keys(odd.table), ['solana']);
  assert.equal(odd.table.solana?.native, undefined, 'a symbol that is not the registry asset is dropped');
  assert.equal(odd.table.robinhood, undefined, 'USDG is never priced from a "USDC" entry');
  for (const body of [null, {}, { ...PRICES_BODY, source: 'Other' }, { ...PRICES_BODY, observedAt: 'yesterday' }, { ...PRICES_BODY, prices: [] }]) {
    assert.throws(() => parsePriceSnapshot(body));
  }
});

test('values are exact to 18 decimal places and rounded half up only for display', () => {
  // The owner's wallet: 0.09833392 SOL at $107.831068.
  const sol = usdValue(98_333_920n, 9, { units: 107831068n, scale: 6 });
  assert.equal(sol, USD('10.60345161422656'));
  assert.equal(formatUsd(sol), '$10.60');
  // Binance-Peg USDC has 18 decimals: 1.5 at $0.999859.
  assert.equal(usdValue(1_500_000_000_000_000_000n, 18, { units: 999859n, scale: 6 }), USD('1.4997885'));
  assert.equal(formatUsd(USD('0.005')), '$0.01');
  assert.equal(formatUsd(USD('0.004999')), '< $0.01');
  assert.equal(formatUsd(0n), '$0.00');
  assert.equal(formatUsd(USD('1234567.995')), '$1,234,568.00');
  assert.equal(formatUsd(USD('8.425')), '$8.43');
  assert.equal(formatUsd(USD('8.42499')), '$8.42');
  assert.deepEqual(usdDisplay(USD('8.425')), { amount: '$8.43', approx: true });
  assert.deepEqual(usdDisplay(USD('0.001')), { amount: '< $0.01', approx: false }, 'never "≈ < $0.01"');
  assert.equal(approxUsd(USD('0.001')), '< $0.01');
  assert.equal(approxUsd(USD('10.6')), '≈ $10.60');
});

test('unit prices read in cents from a dollar up and in four significant digits below it', () => {
  assert.equal(formatPrice({ units: 107831068n, scale: 6 }), '$107.83');
  assert.equal(formatPrice({ units: 2511149244n, scale: 6 }), '$2,511.15');
  assert.equal(formatPrice({ units: 999898n, scale: 6 }), '$0.9999');
  assert.equal(formatPrice({ units: 5n, scale: 1 }), '$0.50');
  assert.equal(formatPrice({ units: 12345n, scale: 9 }), '$0.00001235');
  assert.equal(formatPrice({ units: 999996n, scale: 6 }), '$1.00');
});

test('token amounts are compact and never rounded up', () => {
  assert.equal(compactAmount(98_333_920n, 9), '0.0983');
  assert.equal(compactAmount(5_000_000n, 9), '0.005');
  assert.equal(compactAmount(12_345n, 9), '0.0000123');
  assert.equal(compactAmount(1_234_567_891n, 6), '1,234.5678');
  assert.equal(compactAmount(1_999_999_999_999_999_999n, 18), '1.9999');
  assert.equal(compactAmount(0n, 6), '0');
});

test('the owner case: 0.0983 SOL and 0 USDC is about $10.60, never a zero', () => {
  const holdings = [hold('solana', 'native', 98_333_920n, 9, 'SOL'), hold('solana', 'stablecoin', 0n, 6, 'USDC')];
  const valuation = valuate(holdings, READY);
  assert.equal(valuation.kind, 'usd');
  if (valuation.kind !== 'usd') return;
  assert.equal(formatUsd(valuation.value), '$10.60');
  assert.equal(usdHeadline(valuation), '≈ $10.60');
  assert.deepEqual(valuation.excluded, []);
  assert.equal(priceStamp(valuation.snapshot), `prices from Relay, ${formatClock(PRICES_BODY.observedAt)}`);
  assert.match(valuationTitle(valuation)!, /^Estimated value in US dollars, using Relay prices read at \d\d:\d\d\. Not a quote\.$/);
});

test('mixed decimals across networks add up exactly', () => {
  const holdings = [
    hold('bsc', 'native', 250_000_000_000_000_000n, 18, 'BNB'),
    hold('bsc', 'stablecoin', 1_500_000_000_000_000_000n, 18, 'USDC (Binance-Peg)'),
    hold('robinhood', 'stablecoin', 2_500_000n, 6, 'USDG'),
    hold('solana', 'native', 1_250_000_000n, 9, 'SOL'),
  ];
  const valuation = valuate(holdings, READY);
  assert.equal(valuation.kind, 'usd');
  // 186.115512 + 1.4997885 + 2.4997025 + 134.788835
  if (valuation.kind === 'usd') assert.equal(valuation.value, USD('324.903838'));
});

test('an asset without a price is excluded by name; the rest still add up', () => {
  const partial: PricesState = { status: 'ready', snapshot: parsePriceSnapshot({ ...PRICES_BODY, prices: { ...PRICES_BODY.prices, robinhood: { native: PRICES_BODY.prices.robinhood.native } } }) };
  const holdings = [hold('robinhood', 'native', 10_000_000_000_000_000n, 18, 'ETH'), hold('robinhood', 'stablecoin', 2_500_000n, 6, 'USDG')];
  const valuation = valuate(holdings, partial);
  assert.equal(valuation.kind, 'usd');
  if (valuation.kind !== 'usd') return;
  assert.equal(formatUsd(valuation.value), '$25.11');
  assert.deepEqual(valuation.excluded.map(item => item.label), ['USDG']);
  assert.equal(excludedNote(valuation.excluded, false), 'Excludes 2.5 USDG (no price)');
  assert.equal(excludedNote(valuation.excluded, true), 'Excludes USDG (no price)');
  assert.equal(excludedNote([], false), '');
});

test('with no price at all the largest holding leads, as a token amount', () => {
  const holdings = [hold('solana', 'native', 2_000_000_000n, 9, 'SOL'), hold('solana', 'stablecoin', 50_000_000n, 6, 'USDC'), hold('base', 'native', 0n, 18, 'ETH')];
  for (const prices of [{ status: 'unavailable' } as const, { status: 'ready', snapshot: parsePriceSnapshot({ ...PRICES_BODY, prices: {} }) } as const]) {
    const valuation = valuate(holdings, prices);
    assert.equal(valuation.kind, 'unpriced');
    if (valuation.kind !== 'unpriced') continue;
    assert.equal(valuation.lead.label, 'USDC');
    assert.deepEqual(valuation.others.map(item => item.label), ['SOL'], 'zero balances are not listed');
  }
  // Equal amounts keep registry order: Solana first, native first.
  assert.deepEqual(byAmount([hold('base', 'native', 10n ** 18n, 18, 'ETH'), hold('solana', 'native', 10n ** 9n, 9, 'SOL')]).map(item => item.label), ['SOL', 'ETH']);
});

test('nothing held is an exact $0.00 without a price; while prices load, a holding is pending', () => {
  const empty = [hold('solana', 'native', 0n, 9, 'SOL'), hold('solana', 'stablecoin', 0n, 6, 'USDC')];
  for (const prices of [READY, { status: 'loading' } as const, { status: 'unavailable' } as const]) {
    const valuation = valuate(empty, prices);
    assert.equal(valuation.kind, 'empty');
    if (valuation.kind === 'empty') assert.equal(usdHeadline(valuation), '$0.00');
  }
  assert.equal(valuate([hold('solana', 'native', 1n, 9, 'SOL')], { status: 'loading' }).kind, 'pending');
});

test('Solana devnet tokens are never priced', () => {
  assert.equal(priceFor(READY, 'solana', 'native', 'devnet'), null);
  assert.ok(priceFor(READY, 'solana', 'native', 'mainnet-beta'));
  const valuation = valuate([hold('solana', 'native', 1_000_000_000n, 9, 'SOL')], READY, 'devnet');
  assert.equal(valuation.kind, 'unpriced');
});

test('the clock is the local 24-hour time of the snapshot', () => {
  const date = new Date(PRICES_BODY.observedAt);
  assert.equal(formatClock(PRICES_BODY.observedAt), `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
  assert.equal(formatClock('not a time'), '');
});
