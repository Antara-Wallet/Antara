import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_ASSETS, balanceLabel, canonicalBalance, parseBalanceSnapshot, sameBalanceSession, stablecoinSummary } from './balances';
import type { WalletChain } from './types';

const native = { chain: 'ethereum', symbol: 'ETH', address: null, decimals: 18, raw: '1000000000000000001', formatted: '999999999999', isNative: true };
const usdc = { chain: 'ethereum', symbol: 'USDC', address: BALANCE_ASSETS.ethereum.stablecoin.address, decimals: 6, raw: '2500001', formatted: '999999999999', isNative: false };
const response = () => ({ balances: [{ ...native }, { ...usdc }], failures: [] as string[], observedAt: '2026-10-09T00:00:00.000Z', solanaCluster: 'mainnet-beta' });
const pair = (chain: WalletChain, stableRaw: string, nativeRaw = '0') => [
  { chain, symbol: BALANCE_ASSETS[chain].native.symbol, address: null, decimals: BALANCE_ASSETS[chain].native.decimals, raw: nativeRaw, isNative: true },
  { chain, symbol: BALANCE_ASSETS[chain].stablecoin.symbol, address: BALANCE_ASSETS[chain].stablecoin.address, decimals: BALANCE_ASSETS[chain].stablecoin.decimals, raw: stableRaw, isNative: false },
];
const snapshot = (balances: unknown[], failures: string[] = []) => ({ balances, failures, observedAt: '2026-10-12T00:00:00.000Z', solanaCluster: 'mainnet-beta' });

test('balance refresh identity rejects prior accounts, selected signers and logout', () => {
  const session = { authenticated: true, userId: 'user-a', addresses: { ethereum: '0xAbC', solana: 'SoL' } };
  assert.equal(sameBalanceSession(session, { ...session, addresses: { ...session.addresses, ethereum: '0xabc' } }), true);
  assert.equal(sameBalanceSession(session, { ...session, userId: 'user-b' }), false);
  assert.equal(sameBalanceSession(session, { ...session, authenticated: false }), false);
  assert.equal(sameBalanceSession(session, { ...session, addresses: { ...session.addresses, ethereum: '0xdef' } }), false);
  assert.equal(sameBalanceSession(session, { ...session, addresses: { ...session.addresses, solana: 'sol' } }), false);
});

test('balance assets come from the registry in Solana-first order with per-network stablecoins', () => {
  assert.deepEqual(Object.keys(BALANCE_ASSETS), ['solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  assert.deepEqual(Object.values(BALANCE_ASSETS).map(asset => [asset.native.symbol, asset.stablecoin.label, asset.stablecoin.decimals]), [
    ['SOL', 'USDC', 6], ['ETH', 'USDC', 6], ['BNB', 'USDC (Binance-Peg)', 18], ['ETH', 'USDG', 6], ['ETH', 'USDC', 6],
  ]);
  assert.equal(BALANCE_ASSETS.robinhood.stablecoin.symbol, 'USDG');
  assert.equal(balanceLabel({ chain: 'robinhood', isNative: false }), 'USDG');
  assert.equal(balanceLabel({ chain: 'bsc', isNative: false }), 'USDC (Binance-Peg)');
  const bsc = canonicalBalance('bsc', 1_500_000_000_000_000_000n, false);
  assert.deepEqual([bsc.symbol, bsc.decimals, bsc.formatted, bsc.address], ['USDC', 18, '1.5', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d']);
  assert.equal(canonicalBalance('robinhood', 2_000_000n, false).symbol, 'USDG');
  for (const legacy of ['arbitrum', 'polygon']) assert.throws(() => canonicalBalance(legacy as WalletChain, 1n, true), /not supported/);
  assert.throws(() => canonicalBalance('base', -1n, true));
  assert.throws(() => canonicalBalance('base', 1n << 256n, true));
});

test('balance display derives exact amounts from validated canonical assets, never remote formatted values', () => {
  const result = parseBalanceSnapshot(response(), ['ethereum'], 'mainnet-beta');
  assert.equal(result.balances[0].formatted, '1.000000000000000001');
  assert.equal(result.balances[1].formatted, '2.500001');
});
test('balance snapshots reject substituted assets, duplicates and ambiguous amounts', () => {
  for (const change of [
    { address: BALANCE_ASSETS.base.stablecoin.address }, { decimals: 18 }, { symbol: 'ETH' },
    { raw: '-1' }, { raw: '01' }, { raw: '1e6' }, { raw: '1.5' }, { raw: 1 }, { raw: (1n << 256n).toString() },
  ]) {
    const value = response(); Object.assign(value.balances[1], change);
    assert.throws(() => parseBalanceSnapshot(value, ['ethereum'], 'mainnet-beta'));
  }
  const duplicate = response(); duplicate.balances.push({ ...usdc });
  assert.throws(() => parseBalanceSnapshot(duplicate, ['ethereum'], 'mainnet-beta'));
});
test('BNB Smart Chain and Robinhood Chain stablecoins validate with their own token, symbol and decimals', () => {
  const loaded = parseBalanceSnapshot(snapshot([...pair('bsc', '1500000000000000000', '2'), ...pair('robinhood', '3000000')]), ['bsc', 'robinhood'], 'mainnet-beta').balances;
  assert.deepEqual(loaded.map(balance => [balance.chain, balance.symbol, balance.decimals, balance.formatted]), [
    ['bsc', 'BNB', 18, '0.000000000000000002'], ['bsc', 'USDC', 18, '1.5'], ['robinhood', 'ETH', 18, '0'], ['robinhood', 'USDG', 6, '3'],
  ]);
  // A Circle-style 6-decimal claim (or axlUSDC) on BNB Smart Chain is not Binance-Peg USDC.
  for (const change of [{ decimals: 6 }, { address: BALANCE_ASSETS.ethereum.stablecoin.address }]) {
    const value = snapshot(pair('bsc', '1')); Object.assign(value.balances[1] as object, change);
    assert.throws(() => parseBalanceSnapshot(value, ['bsc'], 'mainnet-beta'));
  }
  // Robinhood Chain has no Circle USDC: a USDC label or the unverified bridged lookalike is rejected.
  for (const change of [{ symbol: 'USDC' }, { address: '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8', symbol: 'USDC' }, { address: '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8' }, { decimals: 18 }]) {
    const value = snapshot(pair('robinhood', '1')); Object.assign(value.balances[1] as object, change);
    assert.throws(() => parseBalanceSnapshot(value, ['robinhood'], 'mainnet-beta'));
  }
});
test('Arbitrum and Polygon balances are no longer accepted', () => {
  const legacy = snapshot([{ chain: 'arbitrum', symbol: 'ETH', address: null, decimals: 18, raw: '0', isNative: true }]);
  assert.throws(() => parseBalanceSnapshot(legacy, ['ethereum'], 'mainnet-beta'));
  assert.throws(() => parseBalanceSnapshot(legacy, ['arbitrum' as WalletChain], 'mainnet-beta'));
  assert.throws(() => parseBalanceSnapshot(snapshot(pair('ethereum', '0'), ['polygon']), ['ethereum'], 'mainnet-beta'));
});
test('unavailable networks are explicit and may not silently appear as empty balances', () => {
  const value = response();
  assert.throws(() => parseBalanceSnapshot(value, ['ethereum', 'base'], 'mainnet-beta'));
  value.failures.push('base');
  assert.equal(parseBalanceSnapshot(value, ['ethereum', 'base'], 'mainnet-beta').balances.length, 2);
  value.failures.push('ethereum');
  assert.throws(() => parseBalanceSnapshot(value, ['ethereum', 'base'], 'mainnet-beta'));
  value.failures = ['unknown'];
  assert.throws(() => parseBalanceSnapshot(value, ['ethereum'], 'mainnet-beta'));
});
test('Solana balances are cluster-bound and USDC is not represented on devnet', () => {
  const value = { balances: [{ chain: 'solana', symbol: 'SOL', address: null, decimals: 9, raw: '0', isNative: true }], failures: [], observedAt: '2026-10-09T00:00:00Z', solanaCluster: 'devnet' };
  assert.equal(parseBalanceSnapshot(value, ['solana'], 'devnet').balances[0].formatted, '0');
  assert.throws(() => parseBalanceSnapshot(value, ['solana'], 'mainnet-beta'), /clusters differ/);
  assert.throws(() => parseBalanceSnapshot({ ...value, solanaCluster: 'mainnet-beta' }, ['solana'], 'mainnet-beta'));
});
test('stablecoin totals keep a loaded zero distinct from failed, missing or devnet balances', () => {
  assert.equal(stablecoinSummary([], ['ethereum']), null);
  assert.equal(stablecoinSummary([], []), null);
  const zero = response(); zero.balances[1].raw = '0';
  assert.equal(stablecoinSummary(parseBalanceSnapshot(zero, ['ethereum'], 'mainnet-beta').balances, ['ethereum'])?.raw, 0n);
  const failed = response(); failed.balances = []; failed.failures = ['ethereum'];
  assert.equal(stablecoinSummary(parseBalanceSnapshot(failed, ['ethereum'], 'mainnet-beta').balances, ['ethereum']), null);
  const devnet = { balances: [{ chain: 'solana', symbol: 'SOL', address: null, decimals: 9, raw: '5', isNative: true }], failures: [], observedAt: '2026-10-09T00:00:00Z', solanaCluster: 'devnet' };
  assert.equal(stablecoinSummary(parseBalanceSnapshot(devnet, ['solana'], 'devnet').balances, ['solana']), null);
  const multi = { ...response(), balances: [{ ...native }, { ...usdc }, { ...native, chain: 'base' }, { ...usdc, chain: 'base', address: BALANCE_ASSETS.base.stablecoin.address, raw: '1' }] };
  const loaded = parseBalanceSnapshot(multi, ['ethereum', 'base'], 'mainnet-beta').balances;
  assert.deepEqual(stablecoinSummary(loaded, ['ethereum', 'base']), { raw: 2500002n, decimals: 6, holdings: [{ label: 'USDC', raw: 2500002n, chains: ['ethereum', 'base'] }] });
  assert.equal(stablecoinSummary(loaded, ['base'])?.raw, 1n);
  // One failed network makes the scoped total unknown, even when every loaded network reports zero.
  const partial = response(); partial.balances[1].raw = '0'; partial.failures = ['base'];
  const partialBalances = parseBalanceSnapshot(partial, ['ethereum', 'base'], 'mainnet-beta').balances;
  assert.equal(stablecoinSummary(partialBalances, ['ethereum', 'base']), null);
  assert.equal(stablecoinSummary(partialBalances, ['base']), null);
  assert.equal(stablecoinSummary(partialBalances, ['ethereum'])?.raw, 0n);
  assert.equal(stablecoinSummary(partialBalances, ['arbitrum' as WalletChain]), null);
});
test('the all-network stablecoin total is exact across decimals and never folds USDG or Binance-Peg USDC into USDC', () => {
  const chains: WalletChain[] = ['solana', 'ethereum', 'bsc', 'robinhood', 'base'];
  const balances = parseBalanceSnapshot(snapshot([
    ...pair('solana', '9000000'), ...pair('ethereum', '25000000'), ...pair('bsc', '1000000000000000001'), ...pair('robinhood', '2500000'), ...pair('base', '0'),
  ]), chains, 'mainnet-beta').balances;
  const summary = stablecoinSummary(balances, chains)!;
  assert.equal(summary.decimals, 18);
  // 9 + 25 + 1.000000000000000001 + 2.5 + 0, at face value, with no rounding.
  assert.equal(summary.raw, 37_500_000_000_000_000_001n);
  assert.deepEqual(summary.holdings.map(holding => [holding.label, holding.raw, holding.chains]), [
    ['USDC', 34_000_000_000_000_000_000n, ['solana', 'ethereum', 'base']],
    ['USDC (Binance-Peg)', 1_000_000_000_000_000_001n, ['bsc']],
    ['USDG', 2_500_000_000_000_000_000n, ['robinhood']],
  ]);
  assert.deepEqual(stablecoinSummary(balances, ['robinhood'])?.holdings.map(holding => holding.label), ['USDG']);
  assert.equal(stablecoinSummary(balances, ['robinhood'])?.decimals, 6);
});
