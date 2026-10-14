import { createPublicClient, erc20Abi, formatUnits, http, type Address } from 'viem';
import { assertSolanaCluster } from '../../../src/solares/wallet/solanaNetwork';
import { SOLANA_NETWORK, SUPPORTED_NETWORKS, type EvmNetwork, type Network, type NetworkKey } from '../../../src/solares/networks';
import { VIEM_CHAINS } from '../../../src/solares/evmChains';
import { serverRpcUrl, solanaCluster } from '../config.js';

/**
 * One exact on-chain balance. Symbol, label, address and decimals come from the
 * pinned registry entry for `chain`, so the funding stablecoin is reported as it
 * is: USDG on Robinhood Chain, Binance-Peg USDC (18 decimals) on BNB Smart
 * Chain, and Circle USDC (6 decimals) on Solana, Ethereum and Base.
 */
export interface NetworkBalance {
  chain: NetworkKey;
  /** On-chain ticker. It can be shared by different issuers, so show `label`. */
  symbol: string;
  /** Display label, for example 'USDC (Binance-Peg)'. Plain 'USDC' only for Circle USDC. */
  label: string;
  /** Token contract or mint; null for the native asset. */
  address: string | null;
  decimals: number;
  raw: string;
  formatted: string;
  isNative: boolean;
}
type BalanceJob = { chain: NetworkKey; read: (signal: AbortSignal) => Promise<NetworkBalance[]> };

/** One slow RPC cannot discard healthy networks or outlive the response budget. */
export async function collectBalances(jobs: BalanceJob[], timeoutMs = 9_000) {
  const results = await Promise.all(jobs.map(async job => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Balance deadline exceeded')); }, timeoutMs);
      });
      const balances = await Promise.race([Promise.resolve().then(() => job.read(controller.signal)), timeout]);
      return { chain: job.chain, balances };
    } catch { return { chain: job.chain, balances: null }; }
    finally { clearTimeout(timer); controller.abort(); }
  }));
  return {
    balances: results.flatMap(result => result.balances ?? []),
    failures: results.filter(result => result.balances === null).map(result => result.chain),
  };
}

function balance(network: Network, raw: bigint, isNative: boolean): NetworkBalance {
  if (raw < 0n || raw > (1n << 256n) - 1n) throw new Error('Invalid RPC amount');
  const asset = isNative ? network.native : network.funding;
  return {
    chain: network.key, symbol: asset.symbol, label: isNative ? asset.symbol : network.funding.label,
    address: isNative ? null : network.funding.address, decimals: asset.decimals,
    raw: raw.toString(), formatted: formatUnits(raw, asset.decimals), isNative,
  };
}

function evmJob(network: EvmNetwork, owner: Address): BalanceJob {
  return { chain: network.key, read: async signal => {
    const client = createPublicClient({ chain: VIEM_CHAINS[network.key], transport: http(serverRpcUrl(network), { timeout: 8_000, retryCount: 0, fetchOptions: { signal } }) });
    // An RPC serving another chain (for example Base behind ROBINHOOD_RPC_URL) is never read as this network.
    if (await client.getChainId() !== network.evmChainId) throw new Error('RPC chain mismatch');
    const token = network.funding.address as Address;
    const [native, funding, decimals] = await Promise.all([
      client.getBalance({ address: owner }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    // Amounts are formatted with the pinned precision; a different on-chain value means the wrong token.
    if (decimals !== network.funding.decimals) throw new Error('Funding token precision mismatch');
    return [balance(network, native, true), balance(network, funding, false)];
  } };
}

async function solanaRpc(method: string, params: unknown[], signal: AbortSignal) {
  const response = await fetch(serverRpcUrl(SOLANA_NETWORK), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal });
  if (!response.ok) throw new Error('Solana RPC unavailable');
  const result = await response.json() as { error?: unknown; result?: unknown };
  if (result.error || result.result === undefined || result.result === null) throw new Error('Solana RPC unavailable');
  return result.result;
}

function solanaJob(owner: string): BalanceJob {
  const network = SOLANA_NETWORK;
  return { chain: network.key, read: async signal => {
    const cluster = solanaCluster();
    await assertSolanaCluster({ getGenesisHash: async () => await solanaRpc('getGenesisHash', [], signal) as string }, cluster);
    const native = await solanaRpc('getBalance', [owner, { commitment: 'confirmed' }], signal) as { value: number };
    if (!Number.isSafeInteger(native.value) || native.value < 0) throw new Error('Invalid RPC balance');
    const balances = [balance(network, BigInt(native.value), true)];
    // The pinned USDC mint exists only on mainnet-beta; devnet reports SOL alone.
    if (cluster === 'mainnet-beta') {
      const mint = network.funding.address;
      const tokens = await solanaRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], signal) as {
        value: Array<{ account: { data: { parsed: { info: { owner: string; mint: string; tokenAmount: { amount: string; decimals: number } } } } } }>;
      };
      if (!Array.isArray(tokens.value)) throw new Error('Invalid token response');
      const amount = tokens.value.reduce((sum, token) => {
        const info = token.account.data.parsed.info;
        if (info.owner !== owner || info.mint !== mint || info.tokenAmount.decimals !== network.funding.decimals
          || typeof info.tokenAmount.amount !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(info.tokenAmount.amount)
          || BigInt(info.tokenAmount.amount) > (1n << 64n) - 1n) throw new Error('Invalid USDC account');
        return sum + BigInt(info.tokenAmount.amount);
      }, 0n);
      balances.push(balance(network, amount, false));
    }
    return balances;
  } };
}

/**
 * Native and funding-stablecoin balances for every supported network, in
 * display order (Solana first). `evmAddress` is read on Ethereum, BNB Smart
 * Chain, Robinhood Chain and Base. A network that fails, stalls or reports the
 * wrong chain is listed in `failures`, never as a zero balance.
 */
export function readWalletBalances(evmAddress: string, solanaAddress: string) {
  const jobs: BalanceJob[] = [];
  for (const network of SUPPORTED_NETWORKS) {
    if (network.vm === 'svm') { if (solanaAddress) jobs.push(solanaJob(solanaAddress)); }
    else if (evmAddress) jobs.push(evmJob(network, evmAddress as Address));
  }
  return collectBalances(jobs);
}
