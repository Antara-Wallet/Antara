import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBalance } from '../../wallet/balances';
import { RELAY_NETWORKS, formatExactAmount, parseFundingAmount, tradeNetwork } from '../model';
import { describeSettlement, parseRelayConfig } from '../review';
import {
  SLIPPAGE_OPTIONS, SPENDING_WALLET_LINE, chipAmounts, fundingBalance, nativeBalance, nativeFeeNotice, slippageLabel,
  statusTone, swapActionLabel, typedUnits, type SwapActionState,
} from './swapModel';

const solana = tradeNetwork(792703809);
const bsc = tradeNetwork(56);
const base = tradeNetwork(8453);
const robinhood = tradeNetwork(4663);
/** The swap terms the server reports: only the 100,000-unit protocol sanity ceiling (no ANTARA swap cap since 2026-10-13). */
const terms = (trade = 100_000n) => ({ tradeUnits: trade });

test('50% and Max use the whole balance; only the protocol sanity ceiling bounds them', () => {
  // 42.5 USDC (6 decimals): Max is the balance, 50% is half of it.
  assert.deepEqual(chipAmounts('42500000', terms(), 6), { half: 21_250_000n, max: 42_500_000n });
  // 5,000 USDC, far above the removed 100-unit cap: Max is still the whole balance.
  assert.deepEqual(chipAmounts('5000000000', terms(), 6), { half: 2_500_000_000n, max: 5_000_000_000n });
  // 18-decimal Binance-Peg USDC: 1.5 in full.
  assert.deepEqual(chipAmounts('1500000000000000000', terms(), 18), { half: 750_000_000_000_000_000n, max: 1_500_000_000_000_000_000n });
  // Only a balance above the 100,000-unit sanity ceiling is bounded, and then by that ceiling alone.
  assert.deepEqual(chipAmounts('250000000000', terms(), 6), { half: 100_000_000_000n, max: 100_000_000_000n });
  // The chips fill text the quote can parse back exactly.
  const { max } = chipAmounts('1500000000000000000', terms(), 18);
  assert.equal(parseFundingAmount(formatExactAmount(max!.toString(), 18), bsc.funding), '1500000000000000000');
  const big = chipAmounts('5000000000', terms(), 6).max!;
  assert.equal(parseFundingAmount(formatExactAmount(big.toString(), 6), solana.funding), '5000000000');
});

test('chips stay disabled while the swap terms or the balance are unknown, or when nothing fits', () => {
  assert.deepEqual(chipAmounts('42500000', null, 6), { half: null, max: null });
  assert.deepEqual(chipAmounts(undefined, terms(), 6), { half: null, max: null });
  assert.deepEqual(chipAmounts(null, terms(), 6), { half: null, max: null });
  assert.deepEqual(chipAmounts('0', terms(), 6), { half: null, max: null });
  // One base unit: Max fills it, 50% rounds down to nothing.
  assert.deepEqual(chipAmounts('1', terms(), 6), { half: null, max: 1n });
  // Malformed balances and a bound above the sanity ceiling never produce an amount.
  assert.deepEqual(chipAmounts('1e9', terms(), 6), { half: null, max: null });
  assert.deepEqual(chipAmounts('42500000', terms(100_001n), 6), { half: null, max: null });
  // A config that fails parsing gives no terms, so no chip amount.
  assert.equal(parseRelayConfig({ configured: true }).limits, null);
});

test('the review shows no swap cap, but keeps the refund and fill-window disclosure', async () => {
  const fixtures = new URL('../../../../server/src/solares/fixtures/relay-orders/', import.meta.url);
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtures), 'utf8'));
  const route = manifest.routes['solana-usdc-to-solana-sol'];
  const quote = JSON.parse(readFileSync(new URL(route.file, fixtures), 'utf8'));
  const reviewed = { quote, intent: route.intent, requestId: quote.requestId, quotedAt: route.receivedAt, expiresAt: route.receivedAt + 90_000 };
  const disclosure = describeSettlement(reviewed, terms(), 'en-US', route.receivedAt);
  assert.equal(disclosure.rows.find(item => item.label === 'Swap limit'), undefined);
  for (const text of [...disclosure.rows.map(row => row.value), ...disclosure.paragraphs]) assert.doesNotMatch(text, /per swap|per 24 hours|limit is/i);
  assert.match(disclosure.rows.find(item => item.label === 'Fill window')?.value ?? '', /\(up to 7 days\)$/);
  assert.match(disclosure.rows.find(item => item.label === 'If not filled')?.value ?? '', /^Refund to your Solana wallet/);
  assert.ok(disclosure.paragraphs.some(text => /could receive less|pay less than you deposited, or nothing/.test(text)));
});

test('typed amounts parse like the quote does, without the cap, and never guess', () => {
  assert.equal(typedUnits('42.5', 6), 42_500_000n);
  assert.equal(typedUnits('0.000001', 6), 1n);
  assert.equal(typedUnits('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(typedUnits('5000', 6), 5_000_000_000n);
  for (const text of ['', '.', '1.', '01', '1,5', '1e3', '-1', ' 1', '1.0000001', '1234567890']) assert.equal(typedUnits(text, 6), null, JSON.stringify(text));
});

test('native and funding balances are matched by network and asset; a missing entry is unknown, not zero', () => {
  const balances = [canonicalBalance('solana', 1_250_000_000n, true), canonicalBalance('solana', 42_500_000n, false), canonicalBalance('base', 0n, true), canonicalBalance('bsc', 1_500_000_000_000_000_000n, false)];
  assert.equal(nativeBalance(balances, solana), 1_250_000_000n);
  assert.equal(nativeBalance(balances, base), 0n);
  assert.equal(nativeBalance(balances, robinhood), null);
  assert.equal(fundingBalance(balances, solana)?.raw, '42500000');
  assert.equal(fundingBalance(balances, bsc)?.raw, '1500000000000000000');
  assert.equal(fundingBalance(balances, base), undefined);
  // The fee notice needs a balance known to be zero.
  assert.equal(nativeFeeNotice(0n, base), 'You need some ETH on Base to pay the network fee.');
  assert.equal(nativeFeeNotice(0n, bsc), 'You need some BNB on BNB Smart Chain to pay the network fee.');
  assert.equal(nativeFeeNotice(null, base), null);
  assert.equal(nativeFeeNotice(1n, solana), null);
});

const ready: SwapActionState = {
  busy: null, configured: true, authenticated: true, sourcePending: false, sameCurrency: false, receiveBlocked: false,
  relayConfigured: true, liveReady: true, insufficient: false, quote: 'none', quoteAmount: '', fundingLabel: 'USDC',
};

test('the submit label ladder keeps its existing labels and adds "Not enough <label>"', () => {
  assert.equal(swapActionLabel(ready), 'Review swap');
  assert.equal(swapActionLabel({ ...ready, quote: 'valid', quoteAmount: '5 USDC' }), 'Confirm swap · 5 USDC');
  assert.equal(swapActionLabel({ ...ready, quote: 'expired', quoteAmount: '5 USDC' }), 'Refresh quote');
  assert.equal(swapActionLabel({ ...ready, busy: 'quote' }), 'Getting quote…');
  assert.equal(swapActionLabel({ ...ready, busy: 'execute' }), 'Confirm in your wallet…');
  assert.equal(swapActionLabel({ ...ready, configured: false, authenticated: false }), 'Sign-in setup required');
  assert.equal(swapActionLabel({ ...ready, authenticated: false }), 'Sign in to swap');
  assert.equal(swapActionLabel({ ...ready, sourcePending: true }), 'Swap in progress');
  assert.equal(swapActionLabel({ ...ready, sameCurrency: true }), 'Choose another token');
  assert.equal(swapActionLabel({ ...ready, receiveBlocked: true }), 'Choose another receiving network');
  assert.equal(swapActionLabel({ ...ready, relayConfigured: null, liveReady: false }), 'Loading…');
  assert.equal(swapActionLabel({ ...ready, relayConfigured: false, liveReady: false }), 'Swaps unavailable');
  assert.equal(swapActionLabel({ ...ready, insufficient: true }), 'Not enough USDC');
  assert.equal(swapActionLabel({ ...ready, insufficient: true, fundingLabel: 'USDC (Binance-Peg)' }), 'Not enough USDC (Binance-Peg)');
  assert.equal(swapActionLabel({ ...ready, insufficient: true, fundingLabel: 'USDG' }), 'Not enough USDG');
  // Unavailable swaps outrank a short balance; a short balance outranks a quote that is still on screen.
  assert.equal(swapActionLabel({ ...ready, insufficient: true, relayConfigured: false, liveReady: false }), 'Swaps unavailable');
  assert.equal(swapActionLabel({ ...ready, insufficient: true, quote: 'valid', quoteAmount: '5 USDC' }), 'Not enough USDC');
  // Never a speed, priority, MEV or fee tier label.
  for (const state of [ready, { ...ready, quote: 'valid' as const, quoteAmount: '5 USDC' }]) assert.doesNotMatch(swapActionLabel(state), /speed|turbo|priority|MEV|ultra/i);
});

test('slippage is 0.5% or 1% only, matching the validator', () => {
  assert.deepEqual(SLIPPAGE_OPTIONS.map(option => option.bps), [50, 100]);
  assert.equal(slippageLabel(50), '0.5%');
  assert.equal(slippageLabel(100), '1%');
});

test('status tones add a mark to a visible label and never claim more than the record says', () => {
  assert.equal(statusTone('success'), 'ok');
  assert.equal(statusTone('failure'), 'danger');
  assert.equal(statusTone('unresolved'), 'warn');
  assert.equal(statusTone('delayed'), 'warn');
  assert.equal(statusTone('pending'), 'neutral');
  assert.equal(statusTone('waiting'), 'neutral');
  assert.equal(statusTone('pending', { notFilled: true }), 'warn');
  // A read-only legacy record is never coloured as delivered or failed.
  assert.equal(statusTone('success', { legacy: true }), 'neutral');
  assert.equal(statusTone('failure', { legacy: true }), 'neutral');
});

test('the spending-wallet line is the neutral spec copy and every network keeps its own funding label', () => {
  assert.equal(SPENDING_WALLET_LINE, 'Spending wallet · funds here are not protected by your vault.');
  assert.deepEqual(RELAY_NETWORKS.map(network => network.funding.label), ['USDC', 'USDC', 'USDC (Binance-Peg)', 'USDG', 'USDC']);
});
