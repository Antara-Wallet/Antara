import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_COPY, VAULT_ACTIVITY_STORAGE_KEY, filterActivity, isVaultActivityRecord, mergeActivity, readVaultActivity,
  type MergeInput, type VaultActivityRecord,
} from './activityModel';
import type { TradeRecord } from '../relay/model';
import type { TransferRecord } from '../transfers/transfer';

const SOL_USER = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const SOL_OTHER = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const MULTISIG = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';
const EVM_USER = '0x1111111111111111111111111111111111111111';
const EVM_OTHER = '0x2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-10-13T10:00:00Z');
const sig = (digit: string) => digit.repeat(88);

const transfer = (overrides: Partial<TransferRecord> = {}): TransferRecord => ({
  id: 't1', chain: 'solana', symbol: 'USDC', amount: '5', recipient: SOL_OTHER, sender: SOL_USER, hash: sig('5'),
  status: 'confirmed', createdAt: '2026-10-12T09:30:00.000Z', ...overrides,
});
const route = (overrides: Partial<Omit<TradeRecord, 'intent'>> & { intent?: Partial<TradeRecord['intent']> } = {}): TradeRecord => {
  const { intent, ...rest } = overrides;
  return {
    requestId: `0x${'a1'.repeat(32)}`, createdAt: Date.parse('2026-10-12T12:00:00Z'), status: 'success', sourceTxHashes: [], destinationTxHashes: [],
    ...rest,
    intent: { originChainId: 792703809, destinationChainId: 792703809, user: SOL_USER, recipient: SOL_USER, amount: '25000000', destinationToken: 'native', slippageBps: 50, ...intent },
  };
};
const vault = (overrides: Partial<VaultActivityRecord> = {}): VaultActivityRecord => ({
  id: 'v1', kind: 'deposit', multisig: MULTISIG, asset: 'USDC', amount: '20', signature: sig('3'), status: 'confirmed', createdAt: '2026-10-06T10:00:00.000Z', ...overrides,
});
const input = (overrides: Partial<MergeInput> = {}): MergeInput => ({
  userId: 'user-1', addresses: { solana: SOL_USER, ethereum: EVM_USER }, transfers: [], routes: [], vault: [], now: NOW, ...overrides,
});

describe('mergeActivity: user and wallet filtering', () => {
  it('returns nothing without a signed-in user', () => {
    assert.deepEqual(mergeActivity(input({ userId: '', transfers: [transfer()] })), []);
  });

  it('shows only the selected wallets’ own transfers and routes', () => {
    const items = mergeActivity(input({
      transfers: [
        transfer({ id: 'mine' }),
        transfer({ id: 'other-wallet', chain: 'ethereum', symbol: 'ETH', amount: '9', sender: EVM_OTHER, recipient: EVM_USER, hash: `0x${'99'.repeat(32)}` }),
        transfer({ id: 'no-sender', sender: undefined }),
      ],
      routes: [
        route(),
        route({ requestId: `0x${'b2'.repeat(32)}`, intent: { user: SOL_OTHER, recipient: SOL_OTHER } }),
      ],
    }));
    assert.deepEqual(items.map(item => item.key), [`route:0x${'a1'.repeat(32)}`, 'transfer:mine']);
  });

  it('matches EVM senders case-insensitively and Solana senders exactly', () => {
    const items = mergeActivity(input({
      transfers: [
        transfer({ id: 'evm-upper', chain: 'base', symbol: 'USDC', sender: EVM_USER.toUpperCase().replace('0X', '0x'), recipient: EVM_OTHER, hash: `0x${'ab'.repeat(32)}` }),
        transfer({ id: 'sol-lower', sender: SOL_USER.toLowerCase() }),
      ],
    }));
    assert.deepEqual(items.map(item => item.key), ['transfer:evm-upper']);
  });

  it('hides another wallet family’s records when that wallet is not connected', () => {
    const items = mergeActivity(input({
      addresses: { solana: null, ethereum: EVM_USER },
      transfers: [transfer()],
      routes: [route()],
      vault: [vault()],
    }));
    assert.deepEqual(items, []);
  });
});

describe('mergeActivity: transfers', () => {
  it('keeps the asserted "<status> · <network>" order and the explorer link', () => {
    const [item] = mergeActivity(input({ transfers: [transfer()] }));
    assert.equal(item.kind, 'Sent');
    assert.equal(item.title, 'Sent USDC');
    assert.equal(item.description, 'Confirmed · Solana');
    assert.equal(item.amount, '5 USDC');
    assert.equal(item.explorer, `https://solscan.io/tx/${sig('5')}`);
    assert.equal(item.tone, 'ok');
    assert.equal(item.legacy, false);
  });

  it('reads a submission-unknown record as "Wallet outcome unknown" and links the sender’s account', () => {
    const [item] = mergeActivity(input({ transfers: [transfer({ chain: 'base', sender: EVM_USER, recipient: EVM_OTHER, hash: '', status: 'submission-unknown' })] }));
    assert.equal(item.title, ACTIVITY_COPY.unknownOutcome);
    assert.equal(item.title, 'Wallet outcome unknown');
    assert.equal(item.description, 'Check wallet history before retrying · Base');
    assert.equal(item.status, 'Wallet outcome unknown');
    assert.equal(item.hash, undefined);
    assert.equal(item.explorer, `https://basescan.org/address/${EVM_USER}`);
    assert.equal(item.tone, 'warn');
  });

  it('labels a reverted transfer and keeps the issuer-qualified symbol', () => {
    const [item] = mergeActivity(input({ transfers: [transfer({ chain: 'bsc', symbol: 'USDC (Binance-Peg)', amount: '3', sender: EVM_USER, recipient: EVM_OTHER, hash: `0x${'cd'.repeat(32)}`, status: 'reverted' })] }));
    assert.equal(item.title, 'Reverted USDC (Binance-Peg)');
    assert.equal(item.amount, '3 USDC (Binance-Peg)');
    assert.equal(item.tone, 'danger');
  });

  it('renders legacy-network transfers read-only, labelled as no longer supported', () => {
    const hash = `0x${'ef'.repeat(32)}`;
    const [item] = mergeActivity(input({ transfers: [transfer({ chain: 'arbitrum', sender: EVM_USER, recipient: EVM_OTHER, hash })] }));
    assert.equal(item.legacy, true);
    assert.equal(item.network, 'Arbitrum (no longer supported)');
    // wallet.spec.ts asserts this text (case-insensitively) on the row.
    assert.match(item.description, /^confirmed · Arbitrum \(no longer supported\)$/i);
    assert.equal(item.explorer, `https://arbiscan.io/tx/${hash}`);
  });

  it('drops malformed transfers', () => {
    const items = mergeActivity(input({
      transfers: [
        transfer({ id: 'bad-amount', amount: '1e9' }),
        transfer({ id: 'bad-status', status: 'pending' as TransferRecord['status'] }),
        transfer({ id: 'bad-chain', chain: 'polygon-zkevm' as TransferRecord['chain'] }),
        transfer({ id: 'bad-date', createdAt: 'yesterday' }),
        null as unknown as TransferRecord,
      ],
    }));
    assert.deepEqual(items, []);
  });
});

describe('mergeActivity: routes', () => {
  it('describes a Solana route and keeps it refreshable', () => {
    const record = route({ sourceTxHashes: [sig('4')] });
    const [item] = mergeActivity(input({ routes: [record] }));
    assert.equal(item.kind, 'Swap');
    assert.equal(item.title, 'USDC → SOL');
    assert.equal(item.description, 'Solana · Success');
    assert.equal(item.amount, '25 USDC');
    assert.equal(item.route, record);
    assert.equal(item.trade, record);
    assert.equal(item.settlement, 'Delivered');
    assert.equal(item.explorer, `https://solscan.io/tx/${sig('4')}`);
    assert.equal(item.receive, 'SOL on Solana');
  });

  it('never calls USDG or Binance-Peg USDC plain USDC', () => {
    const items = mergeActivity(input({
      routes: [
        route({ requestId: `0x${'c3'.repeat(32)}`, intent: { originChainId: 4663, destinationChainId: 4663, user: EVM_USER, recipient: EVM_USER, amount: '2500000' } }),
        route({ requestId: `0x${'d4'.repeat(32)}`, createdAt: Date.parse('2026-10-11T00:00:00Z'), intent: { originChainId: 56, destinationChainId: 56, user: EVM_USER, recipient: EVM_USER, amount: '1500000000000000000' } }),
      ],
    }));
    const robinhood = items.find(item => item.network === 'Robinhood Chain')!;
    assert.equal(robinhood.title, 'USDG → ETH');
    assert.equal(robinhood.amount, '2.5 USDG');
    assert.doesNotMatch(`${robinhood.title} ${robinhood.amount}`, /USDC/);
    const bsc = items.find(item => item.network === 'BNB Smart Chain')!;
    assert.equal(bsc.title, 'USDC (Binance-Peg) → BNB');
    assert.equal(bsc.amount, '1.5 USDC (Binance-Peg)');
  });

  it('renders routes on removed networks read-only: no refresh, "Not tracked" while unsettled', () => {
    const items = mergeActivity(input({
      routes: [
        route({ requestId: `0x${'e5'.repeat(32)}`, intent: { originChainId: 42161, destinationChainId: 8453, user: EVM_USER, recipient: EVM_USER, amount: '7000000', destinationToken: 'USDC' } }),
        route({ requestId: `0x${'f6'.repeat(32)}`, createdAt: Date.parse('2026-10-11T00:00:00Z'), status: 'waiting', intent: { originChainId: 137, destinationChainId: 8453, user: EVM_USER, recipient: EVM_USER, amount: '7000000' } }),
      ],
    }));
    const [settled, open] = items;
    assert.equal(settled.legacy, true);
    assert.equal(settled.route, undefined);
    assert.equal(settled.title, 'USDC → USDC');
    assert.equal(settled.amount, '7 USDC');
    // wallet.spec.ts asserts "Arbitrum (no longer supported) · success" (case-insensitively).
    assert.match(settled.description, /^Arbitrum \(no longer supported\) · success$/i);
    assert.equal(open.status, 'Not tracked');
    assert.equal(open.settlement, 'Not tracked');
    assert.equal(open.route, undefined);
    assert.equal(open.fill, null);
  });

  it('shows the fill window of a settling route, and "Not filled" after its deadline', () => {
    const order = (deadline: number) => ({ orderId: `0x${'cd'.repeat(32)}`, orderSignature: `0x${'ef'.repeat(65)}`, orderData: { version: 'v1', output: { deadline } } }) as unknown as TradeRecord['order'];
    const settling = route({ status: 'pending', settlementUpdatedAt: NOW - 60_000, order: order(Math.floor(NOW / 1000) + 3_600), intent: { originChainId: 8453, destinationChainId: 8453, user: EVM_USER, recipient: EVM_USER, amount: '10000000' } });
    const expired = route({ requestId: `0x${'b2'.repeat(32)}`, status: 'pending', settlementUpdatedAt: NOW - 60_000, order: order(Math.floor(NOW / 1000) - 3_600), intent: { originChainId: 8453, destinationChainId: 8453, user: EVM_USER, recipient: EVM_USER, amount: '10000000' } });
    const [open] = mergeActivity(input({ routes: [settling] }));
    assert.equal(open.status, 'Pending');
    assert.equal(open.settlement, 'Swapping');
    assert.match(open.fill!.detail, /^Relay can fill until /);
    const [late] = mergeActivity(input({ routes: [expired] }));
    assert.equal(late.status, 'Not filled');
    assert.equal(late.tone, 'warn');
    assert.equal(late.fill!.notFilled, true);
  });

  it('drops routes on unknown networks and malformed records', () => {
    const items = mergeActivity(input({
      routes: [
        route({ intent: { originChainId: 999_999, destinationChainId: 8453, user: EVM_USER, recipient: EVM_USER } }),
        route({ requestId: 42 as unknown as string }),
        route({ status: 'teleported' as TradeRecord['status'] }),
        { requestId: 'x' } as unknown as TradeRecord,
      ],
    }));
    assert.deepEqual(items, []);
  });
});

describe('mergeActivity: vault rows', () => {
  it('describes deposits, releases and activation from the vault record only', () => {
    const items = mergeActivity(input({
      vault: [
        vault(),
        vault({ id: 'v2', kind: 'release', amount: '5', recipient: SOL_USER, index: '2', signature: sig('7'), createdAt: '2026-10-12T16:20:00.000Z' }),
        vault({ id: 'v3', kind: 'activation', asset: undefined, amount: undefined, signature: sig('2'), status: 'submitted', createdAt: '2026-10-05T10:00:00.000Z' }),
      ],
    }));
    assert.deepEqual(items.map(item => item.title), ['Vault release #2', 'Vault deposit', 'Vault activation']);
    const [release, deposit, activation] = items;
    assert.equal(release.kind, 'Vault');
    assert.equal(release.to, SOL_USER);
    assert.equal(release.amount, '5 USDC');
    assert.equal(release.explorer, `https://solscan.io/tx/${sig('7')}`);
    assert.equal(deposit.description, 'Solana · Confirmed');
    assert.equal(deposit.to, undefined);
    assert.equal(activation.amount, '');
    assert.equal(activation.status, 'Submitted');
    assert.equal(activation.tone, 'neutral');
  });

  it('drops malformed vault records', () => {
    const bad = [
      vault({ kind: 'withdraw' as VaultActivityRecord['kind'] }),
      vault({ signature: 'not base58 0OIl' }),
      vault({ multisig: '0x1111111111111111111111111111111111111111' }),
      vault({ amount: '-1' }),
      vault({ asset: 'USDG' as VaultActivityRecord['asset'] }),
      vault({ status: 'approved' as VaultActivityRecord['status'] }),
      vault({ createdAt: 'soon' }),
    ];
    for (const record of bad) assert.equal(isVaultActivityRecord(record), false, JSON.stringify(record));
    assert.deepEqual(mergeActivity(input({ vault: bad })), []);
  });

  it('reads the contract storage key per user, newest first, never throwing', () => {
    const store = new Map<string, string>([
      [VAULT_ACTIVITY_STORAGE_KEY('user-1'), JSON.stringify([vault({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }), vault({ id: 'new' }), { id: 'junk' }])],
      [VAULT_ACTIVITY_STORAGE_KEY('user-2'), JSON.stringify([vault({ id: 'someone-else' })])],
      [VAULT_ACTIVITY_STORAGE_KEY('broken'), '{not json'],
    ]);
    const storage = { getItem: (key: string) => store.get(key) ?? null };
    assert.deepEqual(readVaultActivity(storage, 'user-1').map(record => record.id), ['new', 'old']);
    assert.deepEqual(readVaultActivity(storage, 'broken'), []);
    assert.deepEqual(readVaultActivity(storage, 'nobody'), []);
    assert.deepEqual(readVaultActivity({ getItem: () => { throw new Error('blocked'); } }, 'user-1'), []);
    assert.deepEqual(readVaultActivity(undefined, 'user-1'), []);
  });
});

describe('mergeActivity: order and filters', () => {
  const all = mergeActivity(input({
    transfers: [transfer({ id: 'b', createdAt: '2026-10-10T00:00:00.000Z' }), transfer({ id: 'a', createdAt: '2026-10-10T00:00:00.000Z' })],
    routes: [route()],
    vault: [vault({ createdAt: '2026-10-13T09:00:00.000Z' })],
  }));

  it('sorts newest first, ties by key', () => {
    assert.deepEqual(all.map(item => item.key), ['vault:v1', `route:0x${'a1'.repeat(32)}`, 'transfer:a', 'transfer:b']);
  });

  it('de-duplicates repeated records', () => {
    const items = mergeActivity(input({ transfers: [transfer(), transfer()] }));
    assert.equal(items.length, 1);
  });

  it('filters All · Sent · Swaps · Vault', () => {
    assert.equal(filterActivity(all, 'All').length, 4);
    assert.deepEqual(filterActivity(all, 'Sent').map(item => item.kind), ['Sent', 'Sent']);
    assert.deepEqual(filterActivity(all, 'Swap').map(item => item.kind), ['Swap']);
    assert.deepEqual(filterActivity(all, 'Vault').map(item => item.kind), ['Vault']);
  });

  it('never claims protection or invents fiat on any row', () => {
    for (const item of all) assert.doesNotMatch(`${item.title} ${item.description} ${item.amount} ${item.status}`, /protected|secured|\$|€|%/i);
  });
});
