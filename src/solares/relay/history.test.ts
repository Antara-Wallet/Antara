import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTradeHistory, mergeTradeRecord, persistTrade, retainTradeHistory, TRADE_STORAGE_KEY } from './history';
import { applySettlementStatus } from './settlement';
import { formatIntentAmount, relayNetwork, tokenFor, type TradeRecord } from './model';
import { validateIntent } from './validation';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function record(n = 1, status: TradeRecord['status'] = 'pending'): TradeRecord {
  return { requestId: hash(n), createdAt: n, status, sourceTxHashes: [hash(1000 + n)], destinationTxHashes: [],
    intent: { originChainId: 1, destinationChainId: 8453, user: '0x1111111111111111111111111111111111111111', recipient: '0x1111111111111111111111111111111111111111', amount: '1000000', destinationToken: 'USDC', slippageBps: 50 } };
}
function storage(initial: string | null = null) {
  let value = initial;
  return { getItem(_key: string) { return value; }, setItem(key: string, next: string) { assert.equal(key, TRADE_STORAGE_KEY); value = next; } };
}

test('unresolved routes survive the completed-history cap and remain readable after restart', () => {
  const oldPending = record(1);
  const failedFill = record(101, 'failure');
  const data = [oldPending, failedFill, ...Array.from({ length: 70 }, (_, i) => record(i + 2, 'success'))];
  const kept = retainTradeHistory(data);
  assert.equal(kept.length, 52);
  assert.ok(kept.some(item => item.requestId === oldPending.requestId));
  assert.ok(kept.some(item => item.requestId === failedFill.requestId));
  const disk = storage(JSON.stringify(kept));
  persistTrade(record(100, 'success'), false, disk);
  assert.ok(loadTradeHistory(disk).some(item => item.requestId === oldPending.requestId));
  assert.ok(loadTradeHistory(disk).some(item => item.requestId === failedFill.requestId));
  assert.equal(loadTradeHistory(disk).filter(item => item.status === 'success').length, 50);
});

test('write-ahead save refuses quota failure, corrupt history and silently dropped writes before signing', () => {
  const full = { getItem() { return '[]'; }, setItem() { throw new Error('Quota exceeded'); } };
  assert.throws(() => persistTrade(record(201), true, full), /Cannot safely save/);
  assert.throws(() => persistTrade(record(202), true, storage('{')), /unreadable/);
  assert.throws(() => persistTrade(record(203), true, { getItem() { return '[]'; }, setItem() {} }), /Cannot safely save/);
  const disk = storage();
  persistTrade(record(204), true, disk);
  assert.equal(loadTradeHistory(disk)[0].requestId, record(204).requestId);
});

test('post-submission storage failure preserves corrupt recovery data instead of overwriting it', () => {
  const disk = storage(JSON.stringify([record(220), { invalid: true }]));
  const original = disk.getItem(TRADE_STORAGE_KEY);
  assert.ok(loadTradeHistory(disk).some(item => item.requestId === record(220).requestId));
  persistTrade(record(221), false, disk);
  assert.equal(disk.getItem(TRADE_STORAGE_KEY), original);
  assert.ok(loadTradeHistory(disk).some(item => item.requestId === record(221).requestId));
  assert.throws(() => persistTrade(record(222), true, disk), /unreadable/);
});

test('late polling cannot regress a delivered route or remove its transaction hashes', () => {
  const pending = record();
  const delivered = applySettlementStatus(pending, { status: 'success', inTxHashes: [], txHashes: [hash(300)], updatedAt: 300 });
  const stale = applySettlementStatus(delivered, { status: 'pending', txHashes: [], updatedAt: 100 });
  assert.equal(stale.status, 'success');
  assert.deepEqual(stale.sourceTxHashes, pending.sourceTxHashes);
  assert.deepEqual(stale.destinationTxHashes, [hash(300)]);
  const disk = storage(JSON.stringify([delivered]));
  persistTrade(pending, false, disk);
  assert.equal(loadTradeHistory(disk).find(item => item.requestId === pending.requestId)?.status, 'success');
});

test('older intermediate status cannot overwrite a newer update and failed fill can later refund', () => {
  const current = applySettlementStatus(record(), { status: 'submitted', updatedAt: 300 });
  assert.equal(applySettlementStatus(current, { status: 'waiting', updatedAt: 100 }).status, 'submitted');
  const failed = applySettlementStatus(current, { status: 'failure', failReason: 'EXECUTION_REVERTED', updatedAt: 400 });
  const refunded = applySettlementStatus(failed, { status: 'refund', txHashes: [hash(600)], updatedAt: 500 });
  assert.equal(refunded.status, 'refund');
  assert.equal(refunded.detail, undefined);
});

test('delivery evidence without the optional upstream timestamp can complete a previously timestamped route', () => {
  const current = applySettlementStatus(record(), { status: 'submitted', updatedAt: 300 });
  const delivered = applySettlementStatus(current, { status: 'success', txHashes: [hash(600)] });
  assert.equal(delivered.status, 'success');
  assert.equal(delivered.settlementUpdatedAt, 300);
});

test('malformed status, wrong chain, invalid hash and unevidenced completion never mark money delivered', () => {
  for (const patch of [
    { status: 'success' }, { status: 'refund', txHashes: [] }, { status: 'funds-safe' },
    { status: 'pending', originChainId: 0 }, { status: 'pending', destinationChainId: 137 },
    { status: 'success', txHashes: ['not-a-transaction'] }, { status: 'pending', updatedAt: NaN },
  ]) assert.throws(() => applySettlementStatus(record(), patch));
});

test('a shared request identifier cannot overwrite the saved amount or recipient', () => {
  const original = record();
  assert.throws(() => mergeTradeRecord(original, { ...original, intent: { ...original.intent, amount: '2000000' } }), /does not match/);
});


test('custom-token trades survive persistence and reject metadata changes under the same tracker', () => {
  const original = record(930);
  original.intent.destinationToken = { chainId: 8453, address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test token', decimals: 8 };
  const disk = storage();
  persistTrade(original, true, disk);
  const restored = loadTradeHistory(disk).find(item => item.requestId === original.requestId)!;
  assert.deepEqual(restored, original);
  assert.doesNotThrow(() => persistTrade({ ...restored, status: 'submitted' }, true, disk));
  const changed = structuredClone(restored);
  changed.intent.destinationToken = { ...original.intent.destinationToken, decimals: 18 };
  assert.throws(() => mergeTradeRecord(original, changed), /does not match/);
});

test('saved swaps on removed Arbitrum and Polygon networks stay readable, render read-only and never quote again', () => {
  const legacy = (n: number, originChainId: number, destinationChainId: number, destinationToken: TradeRecord['intent']['destinationToken']): TradeRecord => ({
    ...record(n), intent: { ...record(n).intent, originChainId, destinationChainId, destinationToken },
  });
  const arbitrum = legacy(940, 42161, 8453, 'native');
  const polygon = legacy(941, 137, 137, { chainId: 137, address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test token', decimals: 8 });
  const toPolygon = legacy(942, 1, 137, 'USDC');
  const disk = storage(JSON.stringify([arbitrum, polygon, toPolygon]));
  const loaded = loadTradeHistory(disk);
  for (const item of [arbitrum, polygon, toPolygon]) assert.deepEqual(loaded.find(saved => saved.requestId === item.requestId), item);
  // A strict write-ahead read still succeeds, so legacy history never blocks a new supported swap.
  assert.doesNotThrow(() => persistTrade(record(943), true, disk));
  for (const item of [arbitrum, polygon, toPolygon]) {
    const origin = relayNetwork(item.intent.originChainId), target = relayNetwork(item.intent.destinationChainId);
    assert.ok(origin.legacy || target.legacy);
    assert.match((origin.legacy ? origin : target).label, /no longer supported/);
    assert.equal(formatIntentAmount(item.intent), '1 USDC');
    assert.ok(tokenFor(target, item.intent.destinationToken).symbol);
    assert.throws(() => validateIntent(item.intent), /no longer supported/);
  }
  assert.equal(tokenFor(relayNetwork(137), 'native').symbol, 'POL');
  assert.equal(relayNetwork(42161).explorer, 'https://arbiscan.io/tx/');
  // The app never polls or refreshes a legacy route (refreshTrade refuses it), but a stored status update for one still merges and is not rejected.
  const refunded = applySettlementStatus(arbitrum, { status: 'refund', txHashes: [hash(944)], updatedAt: 10 });
  persistTrade(refunded, true, disk);
  assert.equal(loadTradeHistory(disk).find(item => item.requestId === arbitrum.requestId)?.status, 'refund');
  assert.throws(() => relayNetwork(10));
});

test('BNB Smart Chain routes keep 18-decimal Binance-Peg USDC amounts exact through persistence', () => {
  const bsc: TradeRecord = { ...record(950), intent: { ...record(950).intent, originChainId: 56, destinationChainId: 4663, amount: '25000000000000000000', destinationToken: 'native' } };
  const disk = storage();
  persistTrade(bsc, true, disk);
  const restored = loadTradeHistory(disk).find(item => item.requestId === bsc.requestId)!;
  assert.equal(restored.intent.amount, '25000000000000000000');
  assert.equal(formatIntentAmount(restored.intent), '25 USDC (Binance-Peg)');
  const usdg: TradeRecord = { ...record(951), intent: { ...record(951).intent, originChainId: 4663, destinationChainId: 8453, amount: '2500000', destinationToken: 'USDC' } };
  persistTrade(usdg, true, disk);
  assert.equal(formatIntentAmount(loadTradeHistory(disk).find(item => item.requestId === usdg.requestId)!.intent), '2.5 USDG');
});

test('a record keeps its signed settlement order, and older records without one still load', () => {
  const deadline = 1_792_467_219;
  const order = {
    orderId: hash(960), orderSignature: `0x${'ab'.repeat(65)}`,
    orderData: {
      version: 'v1' as const, solverChainId: 'base', solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', salt: '0x01',
      inputs: [{ payment: { chainId: 'ethereum', currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '1000000', weight: '1' }, refunds: [] }],
      output: { chainId: 'base', payments: [], calls: [], deadline, extraData: '0x' }, fees: [],
    },
  };
  const withOrder: TradeRecord = { ...record(960), order };
  const old = record(961);
  const disk = storage(JSON.stringify([old]));
  persistTrade(withOrder, true, disk);
  const loaded = loadTradeHistory(disk);
  assert.deepEqual(loaded.find(item => item.requestId === withOrder.requestId)?.order, order);
  assert.equal(loaded.find(item => item.requestId === old.requestId)?.order, undefined);
  // Status updates keep the order, and a different order under the same tracker is refused.
  const updated = applySettlementStatus(withOrder, { status: 'submitted', updatedAt: 5 });
  assert.equal(updated.order?.orderId, order.orderId);
  assert.equal(mergeTradeRecord(withOrder, { ...withOrder, order: undefined }).order?.orderId, order.orderId);
  assert.throws(() => mergeTradeRecord(withOrder, { ...withOrder, order: { ...order, orderId: hash(962) } }), /does not match/);
  // A malformed saved order makes the record invalid instead of being trusted.
  for (const broken of [{ ...order, orderSignature: '0x12' }, { ...order, orderId: 'x' }, { ...order, orderData: { ...order.orderData, output: { ...order.orderData.output, deadline: -1 } } }]) {
    assert.throws(() => persistTrade({ ...record(963), order: broken }, true, storage()), /Invalid route history/);
  }
});

test('a refund through the destination alternative is accepted with destination-chain evidence', () => {
  const solana = 'GTtzwxqy67xx9DVESJjx28TgXqpc8xTqtiytgNMaQBTE';
  const crossVm: TradeRecord = { ...record(970), intent: { ...record(970).intent, originChainId: 8453, destinationChainId: 792703809, recipient: solana, destinationToken: 'native' } };
  const signature = '5'.repeat(88);
  assert.deepEqual(applySettlementStatus(crossVm, { status: 'refund', txHashes: [signature], updatedAt: 9 }).destinationTxHashes, [signature]);
  assert.deepEqual(applySettlementStatus(crossVm, { status: 'refund', txHashes: [hash(971)], updatedAt: 9 }).destinationTxHashes, [hash(971)]);
  assert.throws(() => applySettlementStatus(crossVm, { status: 'refund', txHashes: ['not-a-transaction'] }), /hashes/);
  // Delivery evidence must still come from the destination chain.
  assert.throws(() => applySettlementStatus(crossVm, { status: 'success', txHashes: [hash(972)] }), /hashes/);
});
