import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeRecord } from './model';
import * as review from './review';
import {
  SOURCE_BLOCK_MS, blocksNewSwap, depositReported, fillWindowNote, formatExactGroupedAmount, formatFillDeadline,
  parseRelayConfig, shortAddress,
} from './review';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const evm = '0x1111111111111111111111111111111111111111';
function record(n: number, patch: Partial<TradeRecord> = {}, intent: Partial<TradeRecord['intent']> = {}): TradeRecord {
  return {
    requestId: hash(n), createdAt: n, status: 'pending', sourceTxHashes: [hash(1000 + n)], destinationTxHashes: [],
    intent: { originChainId: 8453, destinationChainId: 8453, user: evm, recipient: evm, amount: '100000000', destinationToken: 'native', slippageBps: 50, ...intent },
    ...patch,
  };
}

test('swap configuration reads only the 100,000-unit sanity ceiling, never a daily cap, and fails closed on a malformed bound', () => {
  // Owner decision 2026-10-13: the server publishes the protocol sanity ceiling and no daily cap.
  const valid = { configured: true, mode: 'verified-funding-origin', maxTradeUnits: '100000', maxDailyUnits: null, swapLimitsError: null };
  assert.deepEqual(parseRelayConfig(valid), { configured: true, limits: { tradeUnits: 100_000n }, error: '' });
  // An older server's daily value is ignored; its per-swap value is read as the bound.
  assert.deepEqual(parseRelayConfig({ ...valid, maxTradeUnits: '1000', maxDailyUnits: '5000' }).limits, { tradeUnits: 1000n });
  // The previous policy mode, a bound above the sanity ceiling, and malformed values keep swaps disabled.
  for (const config of [
    { configured: true }, { ...valid, mode: 'verified-stablecoin-origin' }, { ...valid, maxTradeUnits: '100001' }, { ...valid, maxTradeUnits: '0' },
    { ...valid, maxTradeUnits: 100 }, { ...valid, maxTradeUnits: '1e2' },
    { ...valid, maxTradeUnits: null, maxDailyUnits: null, swapLimitsError: 'Swap limits are misconfigured on the server.' },
  ]) assert.equal(parseRelayConfig(config).limits, null, JSON.stringify(config));
  assert.equal(parseRelayConfig({ ...valid, swapLimitsError: 'Swap limits are misconfigured on the server.' }).error, 'Swap limits are misconfigured on the server.');
  assert.equal(parseRelayConfig(null).configured, false);
  // No message mentions a specific stablecoin.
  assert.doesNotMatch(parseRelayConfig({ configured: true }).error, /USD/);
});

test('there is no device-local daily swap check any more', () => {
  // Owner decision 2026-10-13 removed the rolling 24-hour swap cap and its local pre-check.
  assert.equal('localDailyLimit' in review, false);
  assert.equal('dailyLimitMessage' in review, false);
});

test('a known deposit stops blocking new swaps after 30 minutes; unknown deposit state always blocks', () => {
  const created = 1_000_000;
  for (const status of ['waiting', 'depositing', 'unresolved'] as const) assert.ok(blocksNewSwap(record(created, { status }), created + 10 * SOURCE_BLOCK_MS));
  for (const status of ['pending', 'submitted', 'delayed'] as const) {
    assert.ok(blocksNewSwap(record(created, { status }), created + SOURCE_BLOCK_MS - 1));
    assert.ok(!blocksNewSwap(record(created, { status }), created + SOURCE_BLOCK_MS));
  }
  for (const status of ['success', 'refund', 'failure'] as const) assert.ok(!blocksNewSwap(record(created, { status }), created));
  assert.ok(depositReported(record(created, { status: 'pending', settlementUpdatedAt: 5 })));
  assert.ok(!depositReported(record(created, { status: 'pending' })));
  assert.ok(!depositReported(record(created, { status: 'waiting', settlementUpdatedAt: 5 })));
});

test('tracked swaps show the fill window, then "Not filled" after the deadline without promising recovery', () => {
  const deadline = 1_792_467_219;
  const order = { orderId: hash(1), orderSignature: `0x${'ab'.repeat(65)}`, orderData: { output: { deadline } } } as unknown as TradeRecord['order'];
  const open = fillWindowNote(record(1, { order }), deadline * 1000 - 1, 'en-US');
  assert.equal(open?.notFilled, false);
  assert.match(open!.detail, /^Relay can fill until Oct (19|20), 2026/);
  const late = fillWindowNote(record(1, { order }), deadline * 1000, 'en-US');
  assert.equal(late?.notFilled, true);
  assert.match(late!.detail, /^Not filled by .+\. Your deposit stays in Relay's depository until Relay refunds it or protocol recovery is used\.$/);
  assert.doesNotMatch(late!.detail, /ANTARA can|guarantee|protect/i);
  assert.equal(fillWindowNote(record(1, { order, status: 'success' }), deadline * 1000), null);
  assert.equal(fillWindowNote(record(1), deadline * 1000), null, 'older records without an order show no fill window');
  // Submitted and delayed deposits are evidence too.
  for (const status of ['submitted', 'delayed'] as const) assert.equal(fillWindowNote(record(1, { order, status }), deadline * 1000, 'en-US')?.notFilled, true, status);
});

test('a saved order without deposit evidence never claims custody, before or after the deadline', () => {
  // The order is saved before the wallet prompt opens: the app can close while it is open (the record stays
  // "waiting"), or the wallet can fail with something other than a rejection (the record becomes "unresolved").
  const deadline = 1_792_467_219;
  const order = { orderId: hash(2), orderSignature: `0x${'ab'.repeat(65)}`, orderData: { output: { deadline } } } as unknown as TradeRecord['order'];
  for (const status of ['waiting', 'depositing', 'unresolved'] as const) {
    const unknown = record(2, { order, status, sourceTxHashes: [], detail: 'Confirm the deposit in your wallet.' });
    const open = fillWindowNote(unknown, deadline * 1000 - 1, 'en-US');
    assert.equal(open?.notFilled, false, status);
    assert.match(open!.detail, /^If your deposit was submitted, Relay can fill it until Oct (19|20), 2026.+\.$/, status);
    const late = fillWindowNote(unknown, deadline * 1000 + 7 * 86_400_000, 'en-US');
    // The record keeps its own label ("Awaiting deposit", "Status unresolved"), never "Not filled".
    assert.equal(late?.notFilled, false, status);
    assert.match(late!.detail, /^Fill window ended .+\. Check status\. If a deposit was made, it stays in Relay's depository until Relay refunds it or protocol recovery is used\.$/, status);
    for (const note of [open!.detail, late!.detail]) {
      assert.doesNotMatch(note, /Your deposit stays|is held|ANTARA can|guarantee|protect/i, status);
    }
  }
});

test('fill deadlines format in several locales without combining dateStyle and timeZoneName', () => {
  const seconds = 1_792_467_433;
  assert.match(formatFillDeadline(seconds, 'en-US'), /2026/);
  for (const locale of ['en-US', 'de-DE', 'ja-JP', undefined]) assert.ok(formatFillDeadline(seconds, locale).length > 8, String(locale));
  assert.equal(shortAddress('9cxezhPUDpfQagzQ8GENnnMiHN4wYxdc36MSJ5LT8oMi'), '9cxezh…8oMi');
  assert.equal(shortAddress('0xe466C456eF161E378D5a1C4dc5BfdbF10172D9dD'), '0xe466…D9dD');
  assert.equal(formatExactGroupedAmount('1000000000000000000001', 18), '1,000.000000000000000001');
  assert.equal(formatExactGroupedAmount('5000000', 6), '5');
});
