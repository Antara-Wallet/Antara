/**
 * Pure model of the Wallet home (docs/UI_ARGUS_PARITY.md 6.4, 6.5): network scope,
 * the balance hero, token rows and token identity. No React and no DOM, so every
 * truth rule here is unit-tested (homeModel.test.ts):
 *
 * - Solana first: rows follow the registry order, native before stablecoin.
 * - Unknown is never a real zero and never "—": a failed or missing network makes its total
 *   unknown, which renders as a muted "0.00" stand-in with its reason (owner rule, 2026-10-13).
 * - Privacy masks every amount as "••••••".
 * - Labels come from the registry: USDG and Binance-Peg USDC are never called plain USDC.
 * - The hero is the total of every asset in scope, in US dollars (owner decision 2026-10-13,
 *   reversing the earlier stablecoin-only face value): "≈ $8.43", with the price source and time.
 *   Prices come from Relay through ANTARA's API (wallet/prices.ts). An asset without a price is
 *   named as excluded, a network that failed to load is named as excluded, and when no held asset
 *   has a price the headline is the largest holding as a token amount. Never a "$0" for funds held.
 * - No 24-hour change, no PnL: ANTARA reads a current price only.
 */
import { SUPPORTED_NETWORKS, byKey, explorerAddressUrl, isNetworkKey, type SolanaCluster } from '../networks';
import { BALANCE_ASSETS } from '../wallet/balances';
import {
  PRICE_SOURCE, approxUsd, compactAmount, excludedNote, formatClock, formatPrice, priceFor, priceStamp, usdDisplay, usdValue, valuate, valuationTitle,
  type Holding, type PricesState,
} from '../wallet/prices';
import { SOLANA_CLUSTER } from '../wallet/config';
import { nativeToken, tradeNetwork, type TradeToken } from '../relay/model';
import type { WalletBalance, WalletChain } from '../wallet/types';

/** Shown, muted (wallet/BalancePlaceholder), for any balance the wallet does not know; the reason travels with it. */
export const UNKNOWN = '0.00';
/** Shown for every amount while "Hide balances" is on. */
export const MASK = '••••••';

/** A network filter value: one network, or every network the account's wallets hold. */
export type NetworkScope = WalletChain | 'all';
export type AssetKind = 'native' | 'stablecoin';

/** Display name of a network; Solana is "Solana devnet" in a devnet build. */
export function networkName(chain: WalletChain, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return chain === 'solana' && cluster === 'devnet' ? 'Solana devnet' : byKey(chain).name;
}

/** Every supported network, in registry order (Solana first). */
export function homeNetworks(cluster: SolanaCluster = SOLANA_CLUSTER): { key: WalletChain; name: string }[] {
  return SUPPORTED_NETWORKS.map(network => ({ key: network.key, name: networkName(network.key, cluster) }));
}

/** Options of the "Filter assets by network" select: All networks, then the five networks in registry order. */
export function networkOptions(cluster: SolanaCluster = SOLANA_CLUSTER): { value: NetworkScope; label: string }[] {
  return [{ value: 'all', label: 'All networks' }, ...homeNetworks(cluster).map(item => ({ value: item.key, label: item.name }))];
}

/** Solana by default; every network for an account that has only an EVM wallet (existing behaviour). */
export function defaultScope(evmOnly: boolean): NetworkScope {
  return evmOnly ? 'all' : 'solana';
}

/** Whether a value read from a <select> is a scope. */
export function isNetworkScope(value: unknown): value is NetworkScope {
  return value === 'all' || isNetworkKey(value);
}

// ---------- Token rows ----------

export interface TokenRow {
  /** Stable key: `${chain}-${kind}`. */
  id: string;
  chain: WalletChain;
  kind: AssetKind;
  /** Registry name, e.g. "Binance-Peg USD Coin". */
  name: string;
  /** Registry label, e.g. "USDC (Binance-Peg)" or "USDG". */
  label: string;
  networkName: string;
  /**
   * Logo and mark style: the ticker for a native coin or Circle USDC, otherwise the neutral
   * "stablecoin" mark, so Binance-Peg USDC and USDG never borrow Circle USDC's mark.
   */
  mark: string;
  /** Exact formatted amount from the balance (registry decimals). */
  balance: string;
  /** Exact raw amount (integer string, units of `decimals`), for USD values. */
  raw: string;
  decimals: number;
  /** Accessible name of the row's button: "SOL on Solana", "USDG on Robinhood Chain". */
  rowName: string;
}

const REGISTRY_INDEX = new Map(SUPPORTED_NETWORKS.map((network, index) => [network.key, index]));

/** Registry order, then native before stablecoin. */
export function compareAssets(a: { chain: WalletChain; kind: AssetKind }, b: { chain: WalletChain; kind: AssetKind }): number {
  const network = (REGISTRY_INDEX.get(a.chain) ?? 99) - (REGISTRY_INDEX.get(b.chain) ?? 99);
  if (network) return network;
  return (a.kind === 'native' ? 0 : 1) - (b.kind === 'native' ? 0 : 1);
}

/** The mark (logo style) for an asset; see TokenRow.mark. */
export function assetMark(chain: WalletChain, kind: AssetKind): string {
  const network = byKey(chain);
  return kind === 'native' ? network.native.symbol : network.funding.circleIssued ? network.funding.symbol : 'stablecoin';
}

/**
 * Rows for the loaded balances in `scope`, filtered by `search` (name, label or network).
 * Only balances the wallet actually loaded become rows: a failed network has none, and a
 * loaded zero stays a zero row. Duplicates and unsupported networks are dropped.
 */
export function tokenRows(balances: readonly WalletBalance[], scope: NetworkScope, search = '', cluster: SolanaCluster = SOLANA_CLUSTER): TokenRow[] {
  const query = search.trim().toLowerCase();
  const seen = new Set<string>();
  const rows: TokenRow[] = [];
  for (const balance of balances) {
    if (!isNetworkKey(balance.chain) || (scope !== 'all' && balance.chain !== scope)) continue;
    const kind: AssetKind = balance.isNative ? 'native' : 'stablecoin';
    const id = `${balance.chain}-${kind}`;
    if (seen.has(id) || !/^\d+$/.test(balance.raw)) continue;
    seen.add(id);
    const asset = BALANCE_ASSETS[balance.chain][kind];
    const name = networkName(balance.chain, cluster);
    rows.push({
      id, chain: balance.chain, kind, name: asset.name, label: asset.label, networkName: name,
      mark: assetMark(balance.chain, kind), balance: balance.formatted, raw: balance.raw, decimals: asset.decimals, rowName: `${asset.label} on ${name}`,
    });
  }
  rows.sort(compareAssets);
  return query ? rows.filter(row => `${row.name} ${row.label} ${row.networkName}`.toLowerCase().includes(query)) : rows;
}

/** An amount, or the privacy mask. */
export function maskAmount(value: string, privacy: boolean): string {
  return privacy ? MASK : value;
}

/** "≈ $8.43" under a token row's amount: "$0.00" for a zero balance, null while its price is not known. */
export function tokenUsd(row: Pick<TokenRow, 'chain' | 'kind' | 'raw' | 'decimals'>, prices: PricesState, cluster: SolanaCluster = SOLANA_CLUSTER): string | null {
  if (!/^\d+$/.test(row.raw)) return null;
  const raw = BigInt(row.raw);
  if (raw === 0n) return '$0.00';
  const price = priceFor(prices, row.chain, row.kind, cluster);
  return price ? approxUsd(usdValue(raw, row.decimals, price)) : null;
}

/** Token detail's price line: "Price ≈ $107.83 · Relay, 12:41", or why there is none. */
export function priceLine(chain: WalletChain, kind: AssetKind, prices: PricesState, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  if (chain === 'solana' && cluster === 'devnet') return 'Devnet tokens have no market price.';
  if (prices.status === 'loading') return 'Reading the price…';
  const price = priceFor(prices, chain, kind, cluster);
  if (!price || prices.status !== 'ready') return `No price from ${PRICE_SOURCE} right now.`;
  const clock = formatClock(prices.snapshot.observedAt);
  return `Price ≈ ${formatPrice(price)} · ${prices.snapshot.source}${clock ? `, ${clock}` : ''}`;
}

// ---------- Balance hero ----------

export interface HeroInput {
  authenticated: boolean;
  ready: boolean;
  scope: NetworkScope;
  balances: readonly WalletBalance[];
  balancesLoading: boolean;
  balancesError: string | null;
  /** The address the hero shows (Solana unless the account is EVM-only). */
  currentAddress: string | null;
  addresses: { solana: string | null; ethereum: string | null };
  privacy: boolean;
  /** USD prices (wallet/usePrices.ts). */
  prices: PricesState;
  cluster?: SolanaCluster;
}

export type HeroValue =
  | { kind: 'masked' }
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  /** The total in US dollars: "$8.43" with `approx` (rendered "≈ $8.43"), or an exact "$0.00" when nothing is held. */
  | { kind: 'usd'; amount: string; approx: boolean }
  /** No held asset has a price: the largest holding, as a token amount. */
  | { kind: 'amount'; amount: string; unit: string };

export interface HeroModel {
  /** "Total balance". */
  label: string;
  value: HeroValue;
  /** Reason a value is not shown ("Sign in to load balances", "Balance unavailable on Base"); undefined when shown or masked. */
  hint?: string;
  /** Tooltip: the hint, or what an estimated total is and where its prices came from. */
  title?: string;
  /** The other holdings when the headline is a token amount ("50 USDC"); empty otherwise or while masked. */
  breakdown: { label: string; amount: string }[];
  /** What the total leaves out: "Excludes Base (couldn't load)", "Excludes 2.5 USDG (no price)". */
  notes: string[];
  /** "2 assets · Solana · prices from Relay, 12:41", or the signed-out, syncing and failed lines. */
  meta: string;
  /** Networks with a loaded row in scope, in registry order (the chain chips). */
  chains: WalletChain[];
  /** A network in scope did not load: the hero offers "Couldn't load · Retry". */
  failed: boolean;
  pending: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The hero's total: every loaded asset in scope (all the account's networks on "All networks"),
 * valued at Relay prices. A network that failed is excluded by name; unknown is never zero.
 */
export function heroModel(input: HeroInput): HeroModel {
  const cluster = input.cluster ?? SOLANA_CLUSTER;
  const signedOut = !input.authenticated;
  // "All networks" covers every network the account's wallets hold.
  const allScope = SUPPORTED_NETWORKS.map(network => network.key).filter(key => key === 'solana' ? signedOut || !!input.addresses.solana : signedOut || !!input.addresses.ethereum);
  const scopeChains: WalletChain[] = input.scope === 'all' ? allScope : [input.scope];
  const rows = signedOut ? [] : tokenRows(input.balances, input.scope, '', cluster);
  const chains = SUPPORTED_NETWORKS.map(network => network.key).filter(key => rows.some(row => row.chain === key));
  // Unknown stays "syncing" until the selected wallet exists and its load completes or fails.
  const pending = !signedOut && (input.balancesLoading || !input.ready || !input.currentAddress || (!chains.length && !input.balancesError));
  const notLoaded = !signedOut && !pending && !chains.length;
  const known = !signedOut && !pending && !notLoaded;
  const missing = known ? scopeChains.filter(chain => !chains.includes(chain)) : [];
  const holdings: Holding[] = rows.map(row => ({ chain: row.chain, kind: row.kind, raw: BigInt(row.raw), decimals: row.decimals, label: row.label }));
  const valuation = valuate(holdings, input.prices, cluster);

  const value: HeroValue = input.privacy ? { kind: 'masked' }
    : signedOut ? { kind: 'signed-out' }
    : pending ? { kind: 'loading' }
    : notLoaded ? { kind: 'unavailable' }
    : valuation.kind === 'empty' ? { kind: 'usd', amount: '$0.00', approx: false }
    : valuation.kind === 'pending' ? { kind: 'loading' }
    : valuation.kind === 'usd' ? { kind: 'usd', ...usdDisplay(valuation.value) }
    : { kind: 'amount', amount: compactAmount(valuation.lead.raw, valuation.lead.decimals), unit: valuation.lead.label };
  const scopeName = input.scope === 'all' ? null : networkName(input.scope, cluster);
  const hint = input.privacy ? undefined
    : signedOut ? 'Sign in to load balances'
    : notLoaded ? (scopeName ? `Balance unavailable on ${scopeName}` : 'Balances unavailable')
    : known && valuation.kind === 'pending' ? 'Reading prices'
    : undefined;
  const breakdown = known && !input.privacy && valuation.kind === 'unpriced'
    ? valuation.others.map(holding => ({ label: holding.label, amount: compactAmount(holding.raw, holding.decimals) }))
    : [];
  const notes: string[] = [];
  if (missing.length) notes.push(`Excludes ${missing.map(chain => networkName(chain, cluster)).join(', ')} (couldn't load)`);
  if (known && valuation.kind === 'usd') {
    const excluded = excludedNote(valuation.excluded, input.privacy);
    if (excluded) notes.push(excluded);
  }
  const priceText = valuation.kind === 'usd' ? priceStamp(valuation.snapshot)
    : valuation.kind === 'pending' ? 'Reading prices'
    : valuation.kind === 'unpriced' ? 'USD value unavailable'
    : '';
  const meta = signedOut ? 'Sign in to view your balance'
    : pending ? 'Syncing your wallets'
    : notLoaded ? 'Unable to load balances'
    : [plural(rows.length, 'asset'), chains.length === 1 ? networkName(chains[0], cluster) : plural(chains.length, 'network'), priceText].filter(Boolean).join(' · ');
  return {
    label: 'Total balance',
    value,
    hint,
    title: hint ?? (known && !input.privacy ? valuationTitle(valuation) : undefined),
    breakdown,
    notes,
    meta,
    chains,
    failed: notLoaded || missing.length > 0,
    pending,
  };
}

/** The empty-list copy under the token table (existing per-network copy). */
export function emptyTokensCopy(input: { loading: boolean; error: boolean; search: string; scope: NetworkScope }): { title: string; text: string } {
  if (input.loading) return { title: 'Loading balances…', text: 'Reading your wallet balances.' };
  if (input.error) return { title: 'Balances unavailable', text: 'Refresh your balances to try again.' };
  if (input.search.trim()) return { title: 'No matching tokens', text: 'Try another token or network.' };
  if (input.scope === 'all') return { title: 'No assets on this network', text: 'Receive native tokens or stablecoins into your wallet to get started.' };
  const network = byKey(input.scope);
  return { title: 'No assets on this network', text: `Receive ${network.native.symbol} or ${network.funding.label} into your wallet to get started.` };
}

// ---------- Token detail ----------

export interface TokenIdentity {
  /** "Native coin of Solana", or "Token · Binance-Peg USD Coin". */
  heading: string;
  /** Contract (EVM) or mint (Solana); null for a native coin. */
  address: string | null;
  /** "Contract" on EVM networks, "Mint" on Solana. */
  addressLabel: string | null;
  decimals: number;
  /** Issuer note for stablecoins Circle does not issue (Binance-Peg USDC, USDG); null otherwise. */
  issuerNote: string | null;
}

export interface TokenDetailModel {
  chain: WalletChain;
  kind: AssetKind;
  name: string;
  label: string;
  symbol: string;
  mark: string;
  networkName: string;
  identity: TokenIdentity;
  explorerName: string;
  /** Swap opens with that pay network (stablecoin), or with the native coin as the receive token. */
  swap: { initialSourceChainId?: number; initialReceive?: TradeToken };
}

export function tokenDetail(chain: WalletChain, kind: AssetKind, cluster: SolanaCluster = SOLANA_CLUSTER): TokenDetailModel {
  const network = byKey(chain);
  const asset = BALANCE_ASSETS[chain][kind];
  const name = networkName(chain, cluster);
  const identity: TokenIdentity = kind === 'native'
    ? { heading: `Native coin of ${name}`, address: null, addressLabel: null, decimals: asset.decimals, issuerNote: null }
    : { heading: `Token · ${asset.name}`, address: asset.address, addressLabel: network.vm === 'svm' ? 'Mint' : 'Contract', decimals: asset.decimals, issuerNote: network.funding.circleIssued ? null : network.funding.issuerNote };
  let swap: TokenDetailModel['swap'] = {};
  if (kind === 'stablecoin') swap = { initialSourceChainId: network.relay.chainId };
  else {
    try { swap = { initialReceive: nativeToken(tradeNetwork(network.relay.chainId)) }; } catch { swap = {}; }
  }
  return { chain, kind, name: asset.name, label: asset.label, symbol: asset.symbol, mark: assetMark(chain, kind), networkName: name, identity, explorerName: network.explorer.name, swap };
}

/** "View your account on Solscan": the wallet's own address on that network's explorer. */
export function accountExplorerUrl(chain: WalletChain, address: string, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return explorerAddressUrl(byKey(chain), address, { solanaCluster: cluster });
}

/** The hero's explorer target: the selected network, or Solscan for "All networks" (Etherscan for an EVM-only account). */
export function heroExplorer(scope: NetworkScope, solanaView: boolean): WalletChain {
  return scope === 'all' ? (solanaView ? 'solana' : 'ethereum') : scope;
}

/** The address a network uses: the Solana wallet on Solana, the EVM wallet everywhere else. */
export function addressFor(chain: WalletChain, addresses: { solana: string | null; ethereum: string | null }): string | null {
  return chain === 'solana' ? addresses.solana : addresses.ethereum;
}
