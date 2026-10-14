import { formatUnits } from 'viem';
import { NETWORK_KEYS, SUPPORTED_NETWORKS, byKey, isNetworkKey, sameNetworkAddress } from '../networks';
import type { WalletBalance, WalletChain, WalletSession } from './types';

/** A balance identity pinned by the network registry: a ticker alone never identifies a currency. */
export interface BalanceAsset {
  readonly symbol: string;
  /** Display label. It differs from `symbol` where the issuer matters, e.g. "USDC (Binance-Peg)". */
  readonly label: string;
  readonly name: string;
  /** Token contract or SPL mint; null for the native coin. */
  readonly address: string | null;
  readonly decimals: number;
}
export interface NetworkBalanceAssets { readonly native: BalanceAsset; readonly stablecoin: BalanceAsset }

/**
 * Native coin and funding stablecoin for every supported network, from the
 * registry: Circle USDC on Solana, Ethereum and Base; Binance-Peg USDC (18
 * decimals) on BNB Smart Chain; Paxos USDG on Robinhood Chain.
 */
export const BALANCE_ASSETS = Object.freeze(Object.fromEntries(SUPPORTED_NETWORKS.map(network => [network.key, Object.freeze({
  native: Object.freeze({ symbol: network.native.symbol, label: network.native.symbol, name: network.native.name, address: null, decimals: network.native.decimals }),
  stablecoin: Object.freeze({ symbol: network.funding.symbol, label: network.funding.label, name: network.funding.name, address: network.funding.address, decimals: network.funding.decimals }),
})]))) as Readonly<Record<WalletChain, NetworkBalanceAssets>>;

const MAX_UINT256 = (1n << 256n) - 1n;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('The balance service returned incomplete or invalid asset data. Retry shortly.');

/** Fail-closed asset lookup: legacy (Arbitrum, Polygon) and unknown networks have no balance assets. */
export function balanceAsset(chain: WalletChain, isNative: boolean): BalanceAsset {
  if (!isNetworkKey(chain)) throw new Error('This network is not supported by ANTARA.');
  return BALANCE_ASSETS[chain][isNative ? 'native' : 'stablecoin'];
}
/** Display label for a balance, e.g. "USDG" on Robinhood Chain or "USDC (Binance-Peg)" on BNB Smart Chain. */
export function balanceLabel(balance: Pick<WalletBalance, 'chain' | 'isNative'>): string {
  return balanceAsset(balance.chain, balance.isNative).label;
}
/** Canonical balance entry with the registry's symbol, address and decimals. Shared with the API server. */
export function canonicalBalance(chain: WalletChain, raw: bigint, isNative: boolean): WalletBalance {
  if (raw < 0n || raw > MAX_UINT256) throw new Error('Invalid balance amount');
  const asset = balanceAsset(chain, isNative);
  return { chain, symbol: asset.symbol, address: asset.address, decimals: asset.decimals, raw: raw.toString(), formatted: formatUnits(raw, asset.decimals), isNative };
}

/** Includes disconnected states; stale refresh callbacks must not cancel the active user's request. */
export function sameBalanceSession(expected: WalletSession, current: WalletSession) {
  return expected.authenticated === current.authenticated && expected.userId === current.userId
    && expected.addresses.solana === current.addresses.solana
    && expected.addresses.ethereum?.toLowerCase() === current.addresses.ethereum?.toLowerCase();
}

/** One entry per distinct stablecoin label, so USDG and Binance-Peg USDC are never folded into "USDC". */
export interface StablecoinHolding { readonly label: string; readonly raw: bigint; readonly chains: readonly WalletChain[] }
export interface StablecoinSummary {
  /** Exact face-value sum, in units of `decimals` (the largest precision in scope). Not a market valuation. */
  readonly raw: bigint;
  readonly decimals: number;
  /** Per-label amounts in units of `decimals`, in network display order. */
  readonly holdings: readonly StablecoinHolding[];
}
/**
 * Exact face-value total of each scoped network's funding stablecoin, or null
 * unless every network in scope loaded it. A failed or missing balance is
 * unknown, never zero. Amounts with different decimals are scaled up, never rounded.
 */
export function stablecoinSummary(balances: readonly WalletBalance[], chains: readonly WalletChain[]): StablecoinSummary | null {
  if (!chains.length) return null;
  const entries: { chain: WalletChain; asset: BalanceAsset; raw: bigint }[] = [];
  for (const chain of new Set(chains)) {
    if (!isNetworkKey(chain)) return null;
    const asset = balanceAsset(chain, false);
    const found = balances.filter(balance => balance.chain === chain && !balance.isNative && balance.symbol === asset.symbol
      && balance.decimals === asset.decimals && typeof balance.address === 'string' && sameNetworkAddress(byKey(chain), balance.address, asset.address!)
      && /^\d+$/.test(balance.raw));
    if (found.length !== 1) return null;
    entries.push({ chain, asset, raw: BigInt(found[0].raw) });
  }
  const decimals = Math.max(...entries.map(entry => entry.asset.decimals));
  const holdings = new Map<string, { label: string; raw: bigint; chains: WalletChain[] }>();
  let raw = 0n;
  for (const entry of entries) {
    const scaled = entry.raw * 10n ** BigInt(decimals - entry.asset.decimals);
    raw += scaled;
    const holding = holdings.get(entry.asset.label) ?? { label: entry.asset.label, raw: 0n, chains: [] };
    holding.raw += scaled; holding.chains.push(entry.chain);
    holdings.set(entry.asset.label, holding);
  }
  return { raw, decimals, holdings: [...holdings.values()] };
}

/** Amounts stay exact throughout; formatting and asset identity are derived locally from the registry. */
export function parseBalanceSnapshot(value: unknown, expectedChains: WalletChain[], cluster: 'mainnet-beta' | 'devnet') {
  if (!object(value) || !Array.isArray(value.balances) || !Array.isArray(value.failures)
    || value.balances.length > NETWORK_KEYS.length * 2 || value.failures.length > NETWORK_KEYS.length
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) throw invalid();
  if (expectedChains.some(chain => !isNetworkKey(chain))) throw invalid();
  if (expectedChains.includes('solana') && value.solanaCluster !== cluster) {
    throw new Error('Frontend and API Solana clusters differ. Check RPC configuration.');
  }
  const failures = value.failures as WalletChain[];
  if (new Set(failures).size !== failures.length || failures.some(chain => !expectedChains.includes(chain))) throw invalid();
  const seen = new Set<string>();
  const balances = value.balances.map((item): WalletBalance => {
    if (!object(item) || !expectedChains.includes(item.chain as WalletChain) || typeof item.isNative !== 'boolean') throw invalid();
    const chain = item.chain as WalletChain;
    if (failures.includes(chain)) throw invalid();
    const key = `${chain}:${item.isNative ? 'native' : 'stablecoin'}`;
    if (seen.has(key) || (chain === 'solana' && cluster === 'devnet' && !item.isNative)) throw invalid();
    seen.add(key);
    // Each network's stablecoin has its own pinned address, symbol and decimals.
    const asset = balanceAsset(chain, item.isNative);
    // Native addresses must be explicitly null (optional chaining yields undefined).
    const sameAsset = item.isNative ? item.address === null
      : typeof item.address === 'string' && sameNetworkAddress(byKey(chain), item.address, asset.address!);
    if (!sameAsset || item.symbol !== asset.symbol || item.decimals !== asset.decimals
      || typeof item.raw !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(item.raw)) throw invalid();
    const raw = BigInt(item.raw);
    if (raw > MAX_UINT256) throw invalid();
    return { chain, symbol: asset.symbol, address: asset.address, decimals: asset.decimals, raw: item.raw, formatted: formatUnits(raw, asset.decimals), isNative: item.isNative };
  });
  // Missing data is a failure, never an implied zero balance.
  for (const chain of expectedChains) if (!failures.includes(chain)) {
    if (!seen.has(`${chain}:native`) || (!(chain === 'solana' && cluster === 'devnet') && !seen.has(`${chain}:stablecoin`))) throw invalid();
  }
  return { balances, failures, observedAt: value.observedAt };
}
