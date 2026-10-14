import {
  EVM_NATIVE_ADDRESS, LEGACY_NETWORKS, SOLANA_RELAY_CHAIN_ID, SUPPORTED_NETWORKS,
  type EvmNetworkKey, type LegacyNetwork, type LegacyNetworkKey, type Network, type NetworkKey,
} from '../networks';

/**
 * Mainnet assets are pinned in the network registry (`../networks`): token
 * tickers alone never identify a currency. Swaps are funded only from the
 * source network's pinned funding stablecoin (Circle USDC on Solana, Ethereum
 * and Base; Binance-Peg USDC on BNB Smart Chain; Paxos USDG on Robinhood Chain).
 */
export const SOLANA_CHAIN_ID = SOLANA_RELAY_CHAIN_ID;
/** The stablecoin a route spends on its source network. Show `label` wherever issuer or precision matters. */
export type RelayFunding = {
  address: string;
  symbol: string;
  label: string;
  name: string;
  decimals: number;
  /** Only Circle-issued USDC may resolve from the legacy 'USDC' destination selector. */
  circleIssued: boolean;
};
type RelayNetworkBase = {
  /** Relay chain id (EVM ids equal their EIP-155 ids). */
  id: number;
  name: string;
  /** Display label; marks legacy networks as no longer supported. */
  label: string;
  vm: 'solana' | 'ethereum';
  /** Relay protocol chain slug used by settlement orders. */
  protocol: string;
  funding: RelayFunding;
  native: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Transaction explorer prefix. */
  explorer: string;
};
/** A network that can quote, validate and sign new routes. */
export type TradeNetwork = RelayNetworkBase & {
  key: NetworkKey;
  legacy: false;
  /** Pinned Relay depository contract (EVM) or program (Solana). A quote cannot choose its own. */
  depository: string;
  vmType: 'solana-vm' | 'ethereum-vm';
  /** Tokens that present themselves as a stablecoin here but are never accepted. */
  rejectedLookalikes: readonly string[];
  registry: Network;
};
/** Read-only metadata so device-local records from removed networks still render. Never tradable. */
export type LegacyRelayNetwork = RelayNetworkBase & { key: LegacyNetworkKey; legacy: true };
export type RelayNetwork = TradeNetwork | LegacyRelayNetwork;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function tradeNetworkFrom(network: Network): TradeNetwork {
  return {
    id: network.relay.chainId,
    key: network.key,
    name: network.name,
    label: network.name,
    vm: network.vm === 'svm' ? 'solana' : 'ethereum',
    protocol: network.relay.slug,
    funding: {
      address: network.funding.address, symbol: network.funding.symbol, label: network.funding.label,
      name: network.funding.name, decimals: network.funding.decimals, circleIssued: network.funding.circleIssued,
    },
    native: network.native.relayAddress,
    nativeSymbol: network.native.symbol,
    nativeDecimals: network.native.decimals,
    explorer: network.explorer.tx,
    legacy: false,
    depository: network.relay.depository,
    vmType: network.relay.vmType,
    rejectedLookalikes: network.rejectedLookalikes,
    registry: network,
  };
}
function legacyNetworkFrom(network: LegacyNetwork): LegacyRelayNetwork {
  return {
    id: network.relay.chainId,
    key: network.key,
    name: network.name,
    label: network.label,
    vm: 'ethereum',
    protocol: network.relay.slug,
    funding: { address: network.usdc.address, symbol: 'USDC', label: 'USDC', name: 'USD Coin', decimals: network.usdc.decimals, circleIssued: true },
    native: EVM_NATIVE_ADDRESS,
    nativeSymbol: network.native.symbol,
    nativeDecimals: network.native.decimals,
    explorer: network.explorer.tx,
    legacy: true,
  };
}
/** Tradable networks in registry display order: Solana, Ethereum, BNB Smart Chain, Robinhood Chain, Base. */
export const RELAY_NETWORKS: readonly TradeNetwork[] = freeze(SUPPORTED_NETWORKS.map(tradeNetworkFrom));
const LEGACY_RELAY_NETWORKS: readonly LegacyRelayNetwork[] = freeze(LEGACY_NETWORKS.map(legacyNetworkFrom));

/**
 * Display lookup for saved records: supported networks plus read-only legacy
 * entries (Arbitrum, Polygon). Unknown ids still throw. Use `tradeNetwork` for
 * anything that quotes, validates a new route or requests a signature.
 */
export function relayNetwork(id: number): RelayNetwork {
  const chain = RELAY_NETWORKS.find((item) => item.id === id) ?? LEGACY_RELAY_NETWORKS.find((item) => item.id === id);
  if (!chain) throw new Error('This network is not enabled for ANTARA trading.');
  return chain;
}
/** Fail-closed lookup: only supported networks may quote, validate or sign. */
export function tradeNetwork(id: number): TradeNetwork {
  const chain = RELAY_NETWORKS.find((item) => item.id === id);
  if (!chain) throw new Error(LEGACY_RELAY_NETWORKS.some((item) => item.id === id)
    ? 'This network is no longer supported by ANTARA. Saved swaps on it are read-only.'
    : 'This network is not enabled for ANTARA trading.');
  return chain;
}
export function isLegacyRelayNetwork(id: number): boolean {
  return LEGACY_RELAY_NETWORKS.some((item) => item.id === id);
}
/**
 * Receiving networks with no read-only capture of an order arriving from another network
 * (docs/RELAY_POLICY_2026-10.md section 8). Same-network swaps on them are captured and stay enabled.
 * Routes from another network into them fail closed until captures are added to relayOrders.test.ts.
 */
export const UNCAPTURED_CROSS_NETWORK_DESTINATIONS: readonly NetworkKey[] = Object.freeze(['bsc', 'robinhood'] as const);
/** Whether a new route may receive on `destinationChainId` when paying on `originChainId`. */
export function receivingEnabled(originChainId: number, destinationChainId: number): boolean {
  if (originChainId === destinationChainId) return RELAY_NETWORKS.some((item) => item.id === destinationChainId);
  const destination = RELAY_NETWORKS.find((item) => item.id === destinationChainId);
  return !!destination && !UNCAPTURED_CROSS_NETWORK_DESTINATIONS.includes(destination.key);
}

/**
 * Per-transaction ceiling on gasLimit × maxFeePerGas, in the network's native
 * base units. ETH-gas networks keep 0.02 ETH. BNB Smart Chain uses 0.01 BNB:
 * that is the 1,000,000 gas limit at 10 gwei, more than three times BSC's
 * historical 3 gwei standard price and far above its current sub-gwei floor,
 * so only a misestimated or manipulated fee reaches it. POL is no longer used.
 */
export const MAX_EVM_GAS_LIMIT = 1_000_000n;
const EVM_FEE_CAP_WEI: Readonly<Record<EvmNetworkKey, bigint>> = Object.freeze({
  ethereum: 2n * 10n ** 16n,
  bsc: 10n ** 16n,
  robinhood: 2n * 10n ** 16n,
  base: 2n * 10n ** 16n,
});
export function evmNetworkFeeCap(network: TradeNetwork): bigint {
  if (network.vm !== 'ethereum' || network.key === 'solana') throw new Error('This network has no EVM fee limit.');
  return EVM_FEE_CAP_WEI[network.key];
}
export function assertEvmNetworkFee(network: TradeNetwork, gasLimit: bigint, maxFeePerGas: bigint): void {
  if (gasLimit <= 0n || maxFeePerGas < 0n || gasLimit > MAX_EVM_GAS_LIMIT || gasLimit * maxFeePerGas > evmNetworkFeeCap(network)) {
    throw new Error('The network fee exceeds the ANTARA transaction limit. Try again later.');
  }
}

export type TradeToken = { chainId: number; address: string; symbol: string; name: string; decimals: number };
// Preserve the two legacy selectors so existing device-local history stays readable.
// 'USDC' means Circle USDC only; it never resolves to another issuer's stablecoin.
export type DestinationToken = 'USDC' | 'native' | TradeToken;
export function fundingToken(network: RelayNetwork): TradeToken {
  const { address, symbol, name, decimals } = network.funding;
  return { chainId: network.id, address, symbol, name, decimals };
}
export function nativeToken(network: RelayNetwork): TradeToken {
  return { chainId: network.id, address: network.native, symbol: network.nativeSymbol, name: network.nativeSymbol, decimals: network.nativeDecimals };
}
/** Pinned assets whose metadata a provider may not change. */
export function pinnedTokens(network: RelayNetwork): TradeToken[] {
  return [nativeToken(network), fundingToken(network)];
}
export function isFundingAddress(network: RelayNetwork, address: string): boolean {
  return sameAddress(address, network.funding.address, network.vm) &&
    (network.legacy || !network.rejectedLookalikes.some((item) => sameAddress(item, address, network.vm)));
}
export function tokenFor(network: RelayNetwork, token: DestinationToken): TradeToken {
  if (typeof token === 'object') return token;
  if (token === 'native') return nativeToken(network);
  if (!network.funding.circleIssued) throw new Error(`USDC is not available on ${network.name}. Select the token again.`);
  return fundingToken(network);
}
/** Display label: a network's funding stablecoin shows its issuer-qualified label (for example "USDC (Binance-Peg)"). */
export function tokenLabel(token: TradeToken): string {
  const network = RELAY_NETWORKS.find((item) => item.id === token.chainId) ?? LEGACY_RELAY_NETWORKS.find((item) => item.id === token.chainId);
  return network && isFundingAddress(network, token.address) && token.decimals === network.funding.decimals ? network.funding.label : token.symbol;
}
export type TradeIntent = {
  originChainId: number;
  destinationChainId: number;
  user: string;
  recipient: string;
  /** Base units of the origin network's funding stablecoin (18 decimals on BNB Smart Chain, 6 elsewhere). */
  amount: string;
  destinationToken: DestinationToken;
  slippageBps: number;
};
export function sameTradeIntent(a: TradeIntent, b: TradeIntent): boolean {
  const destination = relayNetwork(a.destinationChainId);
  const first = tokenFor(destination, a.destinationToken), second = tokenFor(destination, b.destinationToken);
  return a.originChainId === b.originChainId && a.destinationChainId === b.destinationChainId &&
    a.user === b.user && a.recipient === b.recipient && a.amount === b.amount && a.slippageBps === b.slippageBps &&
    first.chainId === second.chainId && sameAddress(first.address, second.address, destination.vm) &&
    first.decimals === second.decimals && first.symbol === second.symbol && first.name === second.name;
}
/** "12.5 USDC (Binance-Peg)": the spent amount in the origin network's funding stablecoin. */
export function formatIntentAmount(intent: Pick<TradeIntent, 'originChainId' | 'amount'>): string {
  const { funding } = relayNetwork(intent.originChainId);
  return `${formatAmount(intent.amount, funding.decimals)} ${funding.label}`;
}
export type SolanaInstruction = {
  programId: string;
  data: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
};
export type RelayTransactionData = {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  chainId?: number;
  gas?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  instructions?: SolanaInstruction[];
  addressLookupTableAddresses?: string[];
};
export type QuoteStep = {
  id: string;
  kind: 'transaction';
  action?: string;
  description?: string;
  requestId?: string;
  items: {
    status: 'incomplete' | 'complete';
    data: RelayTransactionData;
    check?: { endpoint: string; method: 'GET' };
  }[];
};
type QuoteCurrency = { chainId: number; address: string; symbol?: string; decimals?: number };
export type RelayQuote = {
  requestId?: string;
  steps: QuoteStep[];
  details: {
    sender: string;
    recipient: string;
    currencyIn: { currency: QuoteCurrency; amount: string; amountFormatted?: string; amountUsd?: string };
    currencyOut: { currency: QuoteCurrency; amount: string; minimumAmount: string; amountFormatted?: string; amountUsd?: string };
    timeEstimate?: number;
    totalImpact?: { percent?: string; usd?: string };
  };
  fees?: Record<string, { amount?: string; amountUsd?: string; currency?: QuoteCurrency }>;
  protocol: { v2: {
    orderId: string;
    /** Settlement hub kind. Only 'onchain' is accepted. */
    hubType: string;
    /** 65-byte EIP-191 signature over the raw 32-byte order id by the order's solver. */
    orderSignature: string;
    orderData: {
      version: 'v1';
      solverChainId: string;
      solver: string;
      salt: string;
      inputs: { payment: { chainId: string; currency: string; amount: string; weight: string }; refunds: { chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string }[] }[];
      output: { chainId: string; payments: { recipient: string; currency: string; minimumAmount: string; expectedAmount: string }[]; calls: string[]; deadline: number; extraData: string };
      fees: { recipientChainId: string; recipient: string; currencyChainId: string; currency: string; amount: string }[];
    };
    paymentDetails: { chainId: string; depository: string; currency: string; amount: string };
  } };
};
export type ReviewedQuote = {
  quote: RelayQuote;
  intent: TradeIntent;
  requestId: string;
  expiresAt: number;
  quotedAt: number;
};
export type TradeStatus = 'waiting' | 'depositing' | 'pending' | 'submitted' | 'delayed' | 'success' | 'refund' | 'failure' | 'unresolved';
/** The signed settlement order a deposit committed to. Kept so a fill window can be shown and protocol recovery stays possible. */
export type SavedOrder = {
  orderId: string;
  orderData: RelayQuote['protocol']['v2']['orderData'];
  orderSignature: string;
};
export type TradeRecord = {
  requestId: string;
  intent: TradeIntent;
  createdAt: number;
  status: TradeStatus;
  sourceTxHashes: string[];
  destinationTxHashes: string[];
  settlementUpdatedAt?: number;
  detail?: string;
  /** Present on records saved since the October 2026 Relay policy; older records omit it. */
  order?: SavedOrder;
};
/**
 * Relay's solver of record, verified 2026-10-12 on every captured route family:
 * the order's `solver`, the `orderSignature` signer and the first `/chains`
 * `solverAddresses` entry. Only this solver can claim an escrowed deposit, so a
 * quote naming another one fails closed. Rotation needs a reviewed update with
 * fresh captures (docs/RELAY_POLICY_2026-10.md), never the solver a quote names.
 */
export const RELAY_SOLVER = Object.freeze({ chain: 'base', address: '0xf70da97812cb96acdf810712aa562db8dfa3dbef' } as const);
/** Relay erc20Router ("v3 Router"): the EVM fill contract committed in order extraData on chains 1, 56, 4663 and 8453. */
export const RELAY_EVM_FILL_CONTRACT = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
/** Fill window bounds for `output.deadline`, relative to validation time (captured orders: quote time + 7 days). */
export const MIN_FILL_WINDOW_MS = 300_000;
export const MAX_FILL_WINDOW_MS = 7 * 86_400_000 + 900_000;
/**
 * Protocol sanity ceiling for one swap and for a saved route record, in whole funding-stablecoin units. Owner
 * decision 2026-10-13: there is no other per-swap cap and no daily swap cap.
 */
export const MAX_FUNDING_UNITS = 100_000n;
/** The per-swap bound new routes are validated against: the protocol sanity ceiling, not a configurable cap. */
export const RELAY_TRADE_CEILING_UNITS = MAX_FUNDING_UNITS;
export function maxFundingAmount(decimals: number): bigint {
  return MAX_FUNDING_UNITS * 10n ** BigInt(decimals);
}
/**
 * Base units of a funding stablecoin in micro-units (10^-6 of one whole unit), rounded up,
 * so 18-decimal Binance-Peg USDC and the 6-decimal stablecoins share one cap scale.
 */
export function fundingMicroUnits(amount: string, decimals: number): bigint {
  if (!/^\d+$/.test(amount) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid funding amount.');
  const value = BigInt(amount);
  if (decimals <= 6) return value * 10n ** BigInt(6 - decimals);
  const scale = 10n ** BigInt(decimals - 6);
  return (value + scale - 1n) / scale;
}
/** Parse a typed amount of `funding` into exact base units, using that token's own decimals. */
export function parseFundingAmount(text: string, funding: Pick<RelayFunding, 'decimals' | 'label'>, maxUnits: bigint = RELAY_TRADE_CEILING_UNITS): string {
  const { decimals, label } = funding;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Unsupported token decimals.');
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,8})${decimals > 0 ? `(?:\\.\\d{1,${decimals}})?` : ''}$`);
  if (!pattern.test(text)) throw new Error(`Enter a ${label} amount with up to ${decimals} decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (value <= 0n || value > maxUnits * 10n ** BigInt(decimals)) throw new Error(`Trade between ${formatExactAmount('1', decimals)} and ${maxUnits.toLocaleString('en-US')} ${label} at a time.`);
  return value.toString();
}
/** Circle USDC (6 decimals). Kept for existing callers; new code parses with the source network's funding token. */
export function parseUsdcAmount(text: string): string {
  return parseFundingAmount(text, { decimals: 6, label: 'USDC' });
}
export function formatAmount(value: string, decimals = 6): string {
  if (!/^\d+$/.test(value)) return '0';
  const whole = BigInt(value) / 10n ** BigInt(decimals);
  const rawFraction = (BigInt(value) % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  // Keep small non-zero token outputs visible instead of truncating them to zero.
  const precision = whole === 0n ? Math.max(6, rawFraction.search(/[1-9]/) + 4) : 6;
  const fraction = rawFraction.slice(0, precision).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}
/** Full-precision, ungrouped decimal text (for example a "Max" amount an input can parse back exactly). */
export function formatExactAmount(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) return '0';
  if (decimals === 0) return BigInt(value).toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (BigInt(value) % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${BigInt(value) / scale}${fraction ? `.${fraction}` : ''}`;
}
export function isTerminal(status: TradeStatus) { return ['success', 'refund', 'failure'].includes(status); }
export function sameAddress(a: string, b: string, vm: RelayNetwork['vm']) {
  return vm === 'ethereum' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
