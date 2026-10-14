import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EIP1193Provider } from 'viem';
import { SEND_NETWORKS, TransferNotSubmittedError, confirmTransfer, hasUnresolvedTransfer, recordTransfer, sendEvmTransfer, transferExplorer, transferHistory, transferNetworkLabel, validateSendIntent, type PreparedTransfer, type SendIntent } from './transfer';
const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
test('transfers reject zero/self/invalid recipients and fractional precision loss', () => {
  const intent = { chain: 'base' as const, asset: 'stablecoin' as const, sender: from, recipient: to, amount: '1.000001' };
  assert.equal(validateSendIntent(intent).amountRaw, 1_000_001n);
  for (const recipient of [from, '0x0000000000000000000000000000000000000000', 'bad']) assert.throws(() => validateSendIntent({ ...intent, recipient }));
  for (const amount of ['0', '-1', '1.0000001', '1e6', '0x123', 'NaN']) assert.throws(() => validateSendIntent({ ...intent, amount }));
});
test('native EVM amounts preserve integers beyond Number precision', () => {
  assert.equal(validateSendIntent({ chain: 'ethereum', asset: 'native', sender: from, recipient: to, amount: '1.000000000000000001' }).amountRaw, 1000000000000000001n);
});
test('transfer networks follow the registry, Solana first, with each network’s own stablecoin and precision', () => {
  assert.deepEqual(SEND_NETWORKS.map(network => [network.key, network.id, network.symbol, network.stablecoin.label, network.stablecoin.decimals]), [
    ['solana', 792703809, 'SOL', 'USDC', 6], ['ethereum', 1, 'ETH', 'USDC', 6], ['bsc', 56, 'BNB', 'USDC (Binance-Peg)', 18], ['robinhood', 4663, 'ETH', 'USDG', 6], ['base', 8453, 'ETH', 'USDC', 6],
  ]);
  // Binance-Peg USDC keeps all 18 decimals; USDG on Robinhood Chain has 6 and is labelled USDG, never USDC.
  const bsc = validateSendIntent({ chain: 'bsc', asset: 'stablecoin', sender: from, recipient: to, amount: '1.000000000000000001' });
  assert.deepEqual([bsc.amountRaw, bsc.token.label, bsc.token.address], [1000000000000000001n, 'USDC (Binance-Peg)', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d']);
  const robinhood = validateSendIntent({ chain: 'robinhood', asset: 'stablecoin', sender: from, recipient: to, amount: '2.5' });
  assert.deepEqual([robinhood.amountRaw, robinhood.token.label, robinhood.network.id], [2_500_000n, 'USDG', 4663]);
  assert.throws(() => validateSendIntent({ chain: 'robinhood', asset: 'stablecoin', sender: from, recipient: to, amount: '1.0000001' }), /6 decimal/);
  assert.equal(validateSendIntent({ chain: 'bsc', asset: 'native', sender: from, recipient: to, amount: '1' }).token.label, 'BNB');
});
test('Arbitrum, Polygon and unknown assets have no transfer route', () => {
  for (const chain of ['arbitrum', 'polygon', 'bnb']) assert.throws(() => validateSendIntent({ chain, asset: 'native', sender: from, recipient: to, amount: '1' } as unknown as SendIntent), /Unsupported/);
  assert.throws(() => validateSendIntent({ chain: 'base', asset: 'USDC', sender: from, recipient: to, amount: '1' } as unknown as SendIntent), /Unsupported/);
});
test('legacy Arbitrum and Polygon records remain readable but never match a new payment', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const records = [
    { id: 'arb', chain: 'arbitrum', sender: from, recipient: to, symbol: 'USDC', amount: '1', hash: `0x${'aa'.repeat(32)}`, status: 'submitted', createdAt: new Date().toISOString() },
    { id: 'pol', chain: 'polygon', sender: from, recipient: to, symbol: 'POL', amount: '1', hash: '', status: 'submission-unknown', createdAt: new Date().toISOString() },
    { id: 'gone', chain: 'fantom', sender: from, recipient: to, symbol: 'FTM', amount: '1', hash: '', status: 'submitted', createdAt: new Date().toISOString() },
  ];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify(records) } });
  try {
    assert.deepEqual(transferHistory('user-a').map(record => record.id), ['arb', 'pol']);
    assert.equal(transferNetworkLabel('arbitrum'), 'Arbitrum (no longer supported)');
    assert.equal(transferNetworkLabel('bsc'), 'BNB Smart Chain');
    assert.equal(transferExplorer('arbitrum', records[0].hash), `https://arbiscan.io/tx/${records[0].hash}`);
    assert.equal(transferExplorer('polygon', '', from), `https://polygonscan.com/address/${from}`);
    assert.equal(transferExplorer('robinhood', records[0].hash), `https://robinhoodchain.blockscout.com/tx/${records[0].hash}`);
    assert.equal(hasUnresolvedTransfer('user-a', { chain: 'base', asset: 'stablecoin', sender: from, recipient: to, amount: '1' }), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
test('a timeout attempt prevents duplicate payment across decimal spellings and remains user scoped', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key.endsWith(':user-a') ? JSON.stringify([{ id: 'pending', chain: 'base', sender: from, recipient: to, symbol: 'USDC', amount: '1.00', hash: '', status: 'submission-unknown', createdAt: new Date().toISOString() }]) : null } });
  try {
    const intent = { chain: 'base' as const, asset: 'stablecoin' as const, sender: from, recipient: to, amount: '1' };
    assert.equal(hasUnresolvedTransfer('user-a', intent), true);
    assert.equal(hasUnresolvedTransfer('user-b', intent), false);
    assert.equal(hasUnresolvedTransfer('user-a', { ...intent, chain: 'ethereum' }), false);
    assert.equal(hasUnresolvedTransfer('user-a', { ...intent, amount: '2' }), false);
    assert.equal(hasUnresolvedTransfer('user-a', { ...intent, asset: 'native' }), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('a payment cannot start when persistent attempt recording is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } } });
  try {
    assert.throws(() => recordTransfer('user-a', { id: 'attempt', chain: 'base', sender: from, recipient: to, amount: '1', symbol: 'USDC', hash: '', status: 'submission-unknown', createdAt: new Date().toISOString() }, true), /Enable site storage/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

const hash = `0x${'ab'.repeat(32)}`;
function reviewedTransfer(): PreparedTransfer {
  return { chain: 'base', asset: 'native', sender: from, recipient: to, amount: '1', amountRaw: 10n ** 18n, symbol: 'ETH', expires: Date.now() + 90_000, fee: '0.0001 ETH', rent: '0', evm: { to, value: 10n ** 18n, data: '0x', gas: 25_200n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100n, chainId: 8453, nonce: 2 } };
}
function transferProvider() {
  const state = { chain: '0x2105', accounts: [from], nonce: '0x2', sent: [] as unknown[], reads: [] as string[], onNonce: () => {}, onReceipt: () => {}, receiptHash: hash, receiptStatus: '0x1', pendingReceipts: 0, sendError: null as Error | null };
  const provider = { request: async (request: { method: string; params?: unknown[] }) => {
    state.reads.push(request.method);
    if (request.method === 'eth_chainId') return state.chain;
    if (request.method === 'eth_accounts') return state.accounts;
    if (request.method === 'eth_getTransactionCount') { state.onNonce(); return state.nonce; }
    if (request.method === 'eth_sendTransaction') { state.sent.push(request.params?.[0]); if (state.sendError) throw state.sendError; return hash; }
    if (request.method === 'eth_blockNumber') return '0x100';
    if (request.method === 'eth_getTransactionReceipt') {
      state.onReceipt();
      if (state.pendingReceipts > 0) { state.pendingReceipts--; return null; }
      return { transactionHash: state.receiptHash, status: state.receiptStatus, from, to, logs: [], blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x100', transactionIndex: '0x0', cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', type: '0x2' };
    }
    throw new Error(`Unexpected RPC: ${request.method}`);
  } } as EIP1193Provider;
  return { provider, state };
}

test('a reviewed nonce already used by another payment never reaches signing', async () => {
  const { provider, state } = transferProvider(); state.nonce = '0x3';
  await assert.rejects(sendEvmTransfer(reviewedTransfer(), provider), error => error instanceof TransferNotSubmittedError && /nonce/.test(error.message));
  assert.equal(state.sent.length, 0);
});

test('transfer payload must exactly match the reviewed recipient, amount, asset and network', async () => {
  for (const mutate of [
    (review: PreparedTransfer) => { review.evm!.to = from; },
    (review: PreparedTransfer) => { review.evm!.value = 2n * 10n ** 18n; },
    (review: PreparedTransfer) => { review.evm!.chainId = 1; },
    (review: PreparedTransfer) => { review.evm!.data = '0x1234'; },
    (review: PreparedTransfer) => { review.asset = 'stablecoin'; },
    (review: PreparedTransfer) => { review.symbol = 'USDC'; },
    (review: PreparedTransfer) => { review.amountRaw = 1n; },
    (review: PreparedTransfer) => { review.evm!.nonce = -1; },
  ]) {
    const { provider, state } = transferProvider(); const review = reviewedTransfer(); mutate(review);
    await assert.rejects(sendEvmTransfer(review, provider), TransferNotSubmittedError);
    assert.equal(state.sent.length, 0);
  }
});

test('an expired review is rechecked after asynchronous nonce verification', async () => {
  const { provider, state } = transferProvider(); const review = reviewedTransfer();
  const now = Date.now;
  try {
    state.onNonce = () => { Date.now = () => review.expires + 1; };
    await assert.rejects(sendEvmTransfer(review, provider), error => error instanceof TransferNotSubmittedError && /expired/.test(error.message));
    assert.equal(state.sent.length, 0);
  } finally { Date.now = now; }
});

test('send freezes the reviewed payment across asynchronous preflight and sends only once', async () => {
  const { provider, state } = transferProvider(); const review = reviewedTransfer();
  state.onNonce = () => { review.evm!.to = from; review.evm!.value = 999n; };
  assert.equal(await sendEvmTransfer(review, provider), hash);
  assert.equal(state.sent.length, 1);
  assert.equal((state.sent[0] as { to: string }).to.toLowerCase(), to);
  assert.equal((state.sent[0] as { value: string }).value, '0xde0b6b3a7640000');
});

test('a wallet transport timeout after submission remains unknown and is never auto-retried', async () => {
  const { provider, state } = transferProvider(); state.sendError = new Error('Response lost after broadcast');
  await assert.rejects(sendEvmTransfer(reviewedTransfer(), provider), error => error instanceof Error && !(error instanceof TransferNotSubmittedError));
  assert.equal(state.sent.length, 1);
});

test('confirmation accepts only the submitted hash on its original chain', async () => {
  for (const change of ['none', 'reverted', 'before-chain', 'during-chain', 'replacement-hash']) {
    const { provider, state } = transferProvider();
    if (change === 'before-chain') state.chain = '0x1';
    if (change === 'during-chain') state.onReceipt = () => { state.chain = '0x1'; };
    if (change === 'replacement-hash') state.receiptHash = `0x${'ef'.repeat(32)}`;
    if (change === 'reverted') state.receiptStatus = '0x0';
    if (change === 'none' || change === 'reverted') assert.equal(await confirmTransfer(reviewedTransfer(), hash, provider), change === 'none' ? 'confirmed' : 'reverted');
    else await assert.rejects(confirmTransfer(reviewedTransfer(), hash, provider), /network changed|Receipt does not belong/);
    if (change === 'before-chain') assert.equal(state.reads.includes('eth_getTransactionReceipt'), false);
  }
});

test('a pending payment is tracked by its exact receipt without replacement-following RPCs', async () => {
  const { provider, state } = transferProvider(); state.pendingReceipts = 1;
  assert.equal(await confirmTransfer(reviewedTransfer(), hash, provider), 'confirmed');
  assert.equal(state.reads.filter(method => method === 'eth_getTransactionReceipt').length, 2);
  assert.equal(state.reads.includes('eth_getTransactionByHash'), false);
  assert.equal(state.reads.includes('eth_getBlockByNumber'), false);
});
