import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { collectBalances, readWalletBalances, type NetworkBalance } from './balances';
import { SOLANA_GENESIS } from '../../../src/solares/wallet/solanaNetwork';
import { SOLANA_NETWORK, SUPPORTED_EVM_NETWORKS, SUPPORTED_NETWORKS, byKey, type NetworkKey } from '../../../src/solares/networks';

const balance: NetworkBalance = { chain: 'ethereum', symbol: 'ETH', label: 'ETH', address: null, decimals: 18, raw: '42', formatted: '0.000000000000000042', isNative: true };

test('balance deadline preserves healthy chains and aborts stalled RPC work', async () => {
  let aborted = false;
  const result = await collectBalances([
    { chain: 'ethereum', read: async () => [balance] },
    { chain: 'base', read: signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) },
    { chain: 'bsc', read: async () => { throw new Error('RPC down'); } },
  ], 20);
  assert.deepEqual(result.balances, [balance]);
  assert.deepEqual(result.failures, ['base', 'bsc']);
  assert.equal(aborted, true);
});
test('late RPC completions cannot mutate a returned balance snapshot', async () => {
  let resolveLate!: (balances: NetworkBalance[]) => void;
  const result = await collectBalances([{ chain: 'ethereum', read: () => new Promise(resolve => { resolveLate = resolve; }) }], 10);
  resolveLate([balance]);
  await Promise.resolve();
  assert.deepEqual(result, { balances: [], failures: ['ethereum'] });
});
test('balance failures include synchronous validation errors and preserve network order', async () => {
  const result = await collectBalances([
    { chain: 'base', read: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return [{ ...balance, chain: 'base' }]; } },
    { chain: 'ethereum', read: async () => [balance] },
    { chain: 'solana', read: () => { throw new Error('invalid genesis'); } },
  ]);
  assert.deepEqual(result.balances.map(value => value.chain), ['base', 'ethereum']);
  assert.deepEqual(result.failures, ['solana']);
  assert.deepEqual(await readWalletBalances('', ''), { balances: [], failures: [] });
});

const ethereumOwner = '0x1111111111111111111111111111111111111111';
const solanaOwner = '7YttLkHDoNj9wyDur5VTve6gt1drRfTLddUMgh8TCnFH';
const RPC_VARIABLES = ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL', 'ARBITRUM_RPC_URL', 'POLYGON_RPC_URL', 'SOLANA_CLUSTER'];
const BALANCE_OF = '0x70a08231';
const DECIMALS = '0x313ce567';
const word = (value: bigint | number) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
/** Funding balance per network: 2.500001 units at each token's own precision. */
const fundingRaw = (key: NetworkKey) => 2_500_001n * 10n ** BigInt(byKey(key).funding.decimals - 6);

function mockBalanceRpc(t: TestContext, { useDefaults = false } = {}) {
  const previous = new Map(RPC_VARIABLES.map(key => [key, process.env[key]]));
  for (const key of RPC_VARIABLES) delete process.env[key];
  // Every endpoint is either a test host or a pinned registry default; nothing real is contacted.
  const configured = SUPPORTED_NETWORKS.map(network => [network.key, useDefaults ? network.rpc.defaults[0] : `https://balances.test/${network.key}`] as const);
  if (!useDefaults) for (const [key, url] of configured) process.env[byKey(key).rpc.serverEnv] = url;
  // viem normalizes an origin-only URL with a trailing slash, so endpoints compare as parsed URLs.
  const endpoints = new Map<string, NetworkKey>(configured.map(([key, url]) => [new URL(url).href, key]));
  process.env.SOLANA_CLUSTER = 'mainnet-beta';
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const state = {
    chainIds: Object.fromEntries(SUPPORTED_EVM_NETWORKS.map(network => [network.key, network.evmChainId])) as Record<string, number>,
    decimals: Object.fromEntries(SUPPORTED_EVM_NETWORKS.map(network => [network.key, network.funding.decimals])) as Record<string, number>,
    tokenInfo: { owner: solanaOwner, mint: SOLANA_NETWORK.funding.address, tokenAmount: { amount: '2500001', decimals: 6 } },
    calls: [] as string[],
    urls: new Set<string>(),
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)).href;
    const network = endpoints.get(url);
    assert.ok(network, 'tests must never contact an unexpected RPC');
    state.urls.add(url);
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    state.calls.push(`${network}:${request.method}`);
    let result: unknown;
    if (network === 'solana') {
      if (request.method === 'getGenesisHash') result = SOLANA_GENESIS['mainnet-beta'];
      else if (request.method === 'getBalance') result = { value: 1_000_000_001 };
      else if (request.method === 'getTokenAccountsByOwner') {
        assert.equal(request.params[0], solanaOwner);
        assert.deepEqual(request.params[1], { mint: SOLANA_NETWORK.funding.address });
        result = { value: [{ account: { data: { parsed: { info: state.tokenInfo } } } }] };
      } else assert.fail(`Unexpected Solana method ${request.method}`);
    } else {
      if (request.method === 'eth_chainId') result = `0x${state.chainIds[network].toString(16)}`;
      else if (request.method === 'eth_getBalance') result = '0xde0b6b3a7640001';
      else if (request.method === 'eth_call') {
        const transaction = request.params[0] as { to: string; data?: string; input?: string };
        // Only the pinned funding token is read: never a lookalike that merely calls itself USDC.
        assert.equal(transaction.to.toLowerCase(), byKey(network).funding.address.toLowerCase());
        const data = transaction.data ?? transaction.input ?? '';
        if (data.startsWith(BALANCE_OF)) result = word(fundingRaw(network));
        else if (data.startsWith(DECIMALS)) result = word(state.decimals[network]);
        else assert.fail(`Unexpected call ${data.slice(0, 10)}`);
      } else assert.fail(`Unexpected EVM method ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
  });
  return state;
}

test('every supported network is read in display order with its own native asset and funding stablecoin', async t => {
  mockBalanceRpc(t);
  const result = await readWalletBalances(ethereumOwner, solanaOwner);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.balances.map(item => `${item.chain}:${item.isNative ? 'native' : 'funding'}`), [
    'solana:native', 'solana:funding', 'ethereum:native', 'ethereum:funding', 'bsc:native', 'bsc:funding', 'robinhood:native', 'robinhood:funding', 'base:native', 'base:funding',
  ]);
  const funding = (chain: NetworkKey) => result.balances.find(item => item.chain === chain && !item.isNative)!;
  const native = (chain: NetworkKey) => result.balances.find(item => item.chain === chain && item.isNative)!;
  assert.deepEqual(['solana', 'ethereum', 'bsc', 'robinhood', 'base'].map(chain => [native(chain as NetworkKey).symbol, native(chain as NetworkKey).decimals, native(chain as NetworkKey).address]), [
    ['SOL', 9, null], ['ETH', 18, null], ['BNB', 18, null], ['ETH', 18, null], ['ETH', 18, null],
  ]);
  assert.equal(native('ethereum').raw, '1000000000000000001');
  assert.equal(native('solana').formatted, '1.000000001');
  // Circle USDC (6 decimals) on Solana, Ethereum and Base.
  for (const chain of ['solana', 'ethereum', 'base'] as const) {
    assert.deepEqual({ ...funding(chain) }, { chain, symbol: 'USDC', label: 'USDC', address: byKey(chain).funding.address, decimals: 6, raw: '2500001', formatted: '2.500001', isNative: false });
  }
  // Binance-Peg USDC keeps its 18-decimal precision and a label that never implies Circle issuance.
  assert.deepEqual({ ...funding('bsc') }, { chain: 'bsc', symbol: 'USDC', label: 'USDC (Binance-Peg)', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, raw: '2500001000000000000', formatted: '2.500001', isNative: false });
  // Robinhood Chain funds with USDG, which is never reported as USDC.
  assert.deepEqual({ ...funding('robinhood') }, { chain: 'robinhood', symbol: 'USDG', label: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, raw: '2500001', formatted: '2.500001', isNative: false });
  assert.ok(result.balances.every(item => item.chain !== 'robinhood' || !/USDC/.test(item.symbol + item.label)));
});

test('real balance readers reject a wrong EVM chain while preserving healthy EVM and Solana assets', async t => {
  const rpc = mockBalanceRpc(t);
  // A Base endpoint configured as ROBINHOOD_RPC_URL must never be read as Robinhood Chain.
  rpc.chainIds.robinhood = 8453;
  const result = await readWalletBalances(ethereumOwner, solanaOwner);
  assert.deepEqual(result.failures, ['robinhood']);
  assert.deepEqual(result.balances.map(item => item.chain), ['solana', 'solana', 'ethereum', 'ethereum', 'bsc', 'bsc', 'base', 'base']);
  assert.deepEqual(rpc.calls.filter(call => call.startsWith('robinhood:')), ['robinhood:eth_chainId']);
  assert.equal(result.balances.find(item => item.chain === 'base' && !item.isNative)?.symbol, 'USDC');
});

test('a funding token whose on-chain precision differs from the pinned decimals is a failure, never a mis-scaled balance', async t => {
  const rpc = mockBalanceRpc(t);
  rpc.decimals.bsc = 6;
  const result = await readWalletBalances(ethereumOwner, '');
  assert.deepEqual(result.failures, ['bsc']);
  assert.ok(result.balances.every(item => item.chain !== 'bsc'), 'a rejected network cannot leave a partial snapshot');
  assert.deepEqual(result.balances.map(item => item.chain), ['ethereum', 'ethereum', 'robinhood', 'robinhood', 'base', 'base']);
});

test('unset server RPC variables use the registry public endpoints, never viem third-party defaults', async t => {
  const rpc = mockBalanceRpc(t, { useDefaults: true });
  const result = await readWalletBalances(ethereumOwner, solanaOwner);
  assert.deepEqual(result.failures, []);
  assert.equal(result.balances.length, 10);
  assert.deepEqual([...rpc.urls].sort(), SUPPORTED_NETWORKS.map(network => new URL(network.rpc.defaults[0]).href).sort());
});

test('a malformed RPC override fails only that network and is never contacted or echoed', async t => {
  const rpc = mockBalanceRpc(t);
  process.env.BSC_RPC_URL = 'malformed-secret-value';
  const result = await readWalletBalances(ethereumOwner, solanaOwner);
  assert.deepEqual(result.failures, ['bsc']);
  assert.equal(rpc.calls.some(call => call.startsWith('bsc:')), false);
  assert.doesNotMatch(JSON.stringify(result), /malformed-secret-value/);
  assert.equal(result.balances.length, 8);
});

test('removed Arbitrum and Polygon variables are ignored and never read', async t => {
  const rpc = mockBalanceRpc(t);
  process.env.ARBITRUM_RPC_URL = 'https://balances.test/arbitrum';
  process.env.POLYGON_RPC_URL = 'https://balances.test/polygon';
  const result = await readWalletBalances(ethereumOwner, '');
  assert.deepEqual(result.failures, []);
  assert.deepEqual([...new Set(result.balances.map(item => item.chain))], ['ethereum', 'bsc', 'robinhood', 'base']);
  assert.ok(rpc.calls.every(call => !/^(arbitrum|polygon):/.test(call)));
});

test('real Solana reader rejects substituted token owner, mint, or decimals without hiding healthy EVM balances', async t => {
  const rpc = mockBalanceRpc(t);
  const valid = structuredClone(rpc.tokenInfo);
  const baseline = await readWalletBalances(ethereumOwner, solanaOwner);
  assert.deepEqual(baseline.failures, []);
  assert.equal(baseline.balances.length, 10);
  for (const change of [
    { owner: '11111111111111111111111111111111' },
    { mint: 'So11111111111111111111111111111111111111112' },
    { tokenAmount: { amount: '2500001', decimals: 9 } },
  ]) {
    rpc.tokenInfo = { ...valid, ...change };
    const result = await readWalletBalances(ethereumOwner, solanaOwner);
    assert.deepEqual(result.failures, ['solana']);
    assert.equal(result.balances.length, 8);
    assert.ok(result.balances.every(item => item.chain !== 'solana'), 'a rejected token response cannot leave a partial healthy-looking Solana snapshot');
    assert.equal(result.balances.find(item => item.chain === 'robinhood' && !item.isNative)?.raw, '2500001');
  }
});
