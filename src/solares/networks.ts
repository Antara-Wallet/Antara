/**
 * ANTARA network registry: the single source of truth for supported networks.
 *
 * Solana is the primary network. Display order is fixed: Solana, Ethereum,
 * BNB Smart Chain, Robinhood Chain, Base. Arbitrum (42161) and Polygon (137)
 * are no longer supported; LEGACY_NETWORKS keeps only the read-only metadata
 * that previously saved device-local records need to render. Legacy networks
 * are never selectable and never resolve through the supported lookups.
 *
 * The frontend and the API server both import this module. Keep it free of
 * React, DOM, Vite (`import.meta.env`), Node (`process`) and package imports;
 * callers pass environment values in explicitly.
 *
 * Ids, addresses and decimals were checked against live RPC, Relay and Safe
 * data on 2026-10-12. They are pinned: a ticker never identifies a currency.
 */

export type NetworkKey = 'solana' | 'ethereum' | 'bsc' | 'robinhood' | 'base';
export type EvmNetworkKey = Exclude<NetworkKey, 'solana'>;
export type NetworkVm = 'svm' | 'evm';
/** Relay protocol chain slug. BNB Smart Chain is 'bnb' at Relay, not 'bsc'. */
export type RelayProtocolSlug = 'solana' | 'ethereum' | 'bnb' | 'robinhood' | 'base';
export type SupportedEvmChainId = 1 | 56 | 4663 | 8453;
export const SOLANA_RELAY_CHAIN_ID = 792703809;
export type SupportedRelayChainId = typeof SOLANA_RELAY_CHAIN_ID | SupportedEvmChainId;
export type SolanaCluster = 'mainnet-beta' | 'devnet';

/** Relay's EVM depository is identical on chains 1, 56, 4663 and 8453. */
export const RELAY_EVM_DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
export const RELAY_SOLANA_DEPOSITORY_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const RELAY_SOLANA_DEPOSITORY_VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
export const EVM_NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
export const SOLANA_NATIVE_ADDRESS = '11111111111111111111111111111111';
export const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';
/**
 * Keyless hosts that answer HTTP 403 to any request carrying an Origin header,
 * which every browser, the desktop webview and the extension send. They work
 * from the server only, so a browser RPC setting must not use them
 * (api.mainnet-beta.solana.com observed 2026-10-13; preflight passes, the call is refused).
 */
export const BROWSER_REFUSED_RPC_HOSTS: readonly string[] = Object.freeze(['api.mainnet-beta.solana.com']);

/**
 * The stablecoin a network's swaps are funded from. Its on-chain ticker may be
 * shared with a different issuer's token, so show `label` wherever the issuer
 * or precision matters. `label` is a plain 'USDC' only for Circle-issued USDC.
 */
export interface FundingStablecoin {
  readonly symbol: string;
  readonly label: string;
  readonly name: string;
  /** EIP-55 contract address (EVM) or SPL mint (Solana). */
  readonly address: string;
  readonly decimals: number;
  readonly issuer: 'Circle' | 'Binance' | 'Paxos';
  readonly circleIssued: boolean;
  readonly issuerNote: string;
}
export interface NetworkNativeAsset {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Relay's currency address for the native asset. */
  readonly relayAddress: string;
}
export interface NetworkExplorer {
  readonly name: string;
  /** Prefix for a transaction hash or signature. */
  readonly tx: string;
  /** Prefix for an account, wallet or contract address. */
  readonly address: string;
}
export interface NetworkRpc {
  /** Official or keyless public endpoints; the first is the server default. All are rate-limited. */
  readonly defaults: readonly string[];
  /**
   * Browser default when it differs from defaults[0]: an endpoint that refuses
   * requests carrying an Origin header cannot serve the web app, the desktop
   * webview or the extension. It is also listed in `defaults`.
   */
  readonly browserDefault?: string;
  /** Server-only override. It may carry a provider key, so it never reaches the browser. */
  readonly serverEnv: string;
  /** Optional browser override. It is compiled into the public bundle and must never contain a secret. */
  readonly browserEnv: string;
}
export interface NetworkRelay {
  readonly chainId: SupportedRelayChainId;
  readonly slug: RelayProtocolSlug;
  /** VM name used by Relay's settlement order-id derivation. */
  readonly vmType: 'solana-vm' | 'ethereum-vm';
  /** Depository contract (EVM) or depository program (Solana). */
  readonly depository: string;
}
interface NetworkBase {
  readonly key: NetworkKey;
  readonly name: string;
  readonly shortName: string;
  readonly vm: NetworkVm;
  readonly evmChainId: SupportedEvmChainId | null;
  readonly relay: NetworkRelay;
  readonly native: NetworkNativeAsset;
  readonly funding: FundingStablecoin;
  readonly explorer: NetworkExplorer;
  readonly rpc: NetworkRpc;
  /** Canonical Safe deployments exist for this chain. Solana vaults use Squads instead. */
  readonly safeSupported: boolean;
  /** Tokens that present themselves as USDC here but are never accepted as funding. */
  readonly rejectedLookalikes: readonly string[];
}
export interface SolanaNetwork extends NetworkBase {
  readonly key: 'solana';
  readonly vm: 'svm';
  readonly evmChainId: null;
  readonly safeSupported: false;
}
export interface EvmNetwork extends NetworkBase {
  readonly key: EvmNetworkKey;
  readonly vm: 'evm';
  readonly evmChainId: SupportedEvmChainId;
}
export type Network = SolanaNetwork | EvmNetwork;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const CIRCLE_USDC_NOTE = 'Native USDC issued by Circle.';
const evmExplorer = (name: string, origin: string): NetworkExplorer => ({ name, tx: `${origin}/tx/`, address: `${origin}/address/` });
const evmRelay = (chainId: SupportedEvmChainId, slug: RelayProtocolSlug): NetworkRelay => ({ chainId, slug, vmType: 'ethereum-vm', depository: RELAY_EVM_DEPOSITORY });
const ether = (): NetworkNativeAsset => ({ symbol: 'ETH', name: 'Ether', decimals: 18, relayAddress: EVM_NATIVE_ADDRESS });

export const SOLANA_NETWORK: SolanaNetwork = deepFreeze<SolanaNetwork>({
  key: 'solana',
  name: 'Solana',
  shortName: 'Solana',
  vm: 'svm',
  evmChainId: null,
  relay: { chainId: SOLANA_RELAY_CHAIN_ID, slug: 'solana', vmType: 'solana-vm', depository: RELAY_SOLANA_DEPOSITORY_PROGRAM },
  native: { symbol: 'SOL', name: 'Solana', decimals: 9, relayAddress: SOLANA_NATIVE_ADDRESS },
  funding: { symbol: 'USDC', label: 'USDC', name: 'USD Coin', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, issuer: 'Circle', circleIssued: true, issuerNote: CIRCLE_USDC_NOTE },
  explorer: { name: 'Solscan', tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  // The official endpoint refuses browser requests (BROWSER_REFUSED_RPC_HOSTS), so
  // the browser default is a keyless gateway that accepts them (checked 2026-10-13).
  rpc: {
    defaults: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    browserDefault: 'https://solana-rpc.publicnode.com',
    serverEnv: 'SOLANA_RPC_URL',
    browserEnv: 'VITE_SOLANA_RPC_URL',
  },
  safeSupported: false,
  rejectedLookalikes: [],
});

const EVM_LIST: readonly EvmNetwork[] = [
  {
    key: 'ethereum',
    name: 'Ethereum',
    shortName: 'Ethereum',
    vm: 'evm',
    evmChainId: 1,
    relay: evmRelay(1, 'ethereum'),
    native: ether(),
    funding: { symbol: 'USDC', label: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, issuer: 'Circle', circleIssued: true, issuerNote: CIRCLE_USDC_NOTE },
    explorer: evmExplorer('Etherscan', 'https://etherscan.io'),
    rpc: { defaults: ['https://ethereum-rpc.publicnode.com'], serverEnv: 'ETHEREUM_RPC_URL', browserEnv: 'VITE_ETHEREUM_RPC_URL' },
    safeSupported: true,
    rejectedLookalikes: [],
  },
  {
    key: 'bsc',
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    vm: 'evm',
    evmChainId: 56,
    relay: evmRelay(56, 'bnb'),
    native: { symbol: 'BNB', name: 'BNB', decimals: 18, relayAddress: EVM_NATIVE_ADDRESS },
    funding: {
      symbol: 'USDC',
      label: 'USDC (Binance-Peg)',
      name: 'Binance-Peg USD Coin',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      issuer: 'Binance',
      circleIssued: false,
      issuerNote: 'Binance-Peg USDC is a bridged token issued by Binance on BNB Smart Chain, not by Circle. It uses 18 decimals, unlike Circle USDC (6).',
    },
    explorer: evmExplorer('BscScan', 'https://bscscan.com'),
    rpc: { defaults: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], serverEnv: 'BSC_RPC_URL', browserEnv: 'VITE_BSC_RPC_URL' },
    safeSupported: true,
    rejectedLookalikes: [],
  },
  {
    key: 'robinhood',
    name: 'Robinhood Chain',
    shortName: 'Robinhood',
    vm: 'evm',
    evmChainId: 4663,
    relay: evmRelay(4663, 'robinhood'),
    native: ether(),
    funding: {
      symbol: 'USDG',
      label: 'USDG',
      name: 'Paxos Global Dollar',
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      decimals: 6,
      issuer: 'Paxos',
      circleIssued: false,
      issuerNote: 'USDG (Global Dollar) is issued by Paxos. It is not USDC; Robinhood Chain had no Circle-issued USDC as of 2026-10-12.',
    },
    explorer: evmExplorer('Blockscout', 'https://robinhoodchain.blockscout.com'),
    rpc: { defaults: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'], serverEnv: 'ROBINHOOD_RPC_URL', browserEnv: 'VITE_ROBINHOOD_RPC_URL' },
    safeSupported: true,
    // An unverified bridged token that names itself USDC.
    rejectedLookalikes: ['0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8'],
  },
  {
    key: 'base',
    name: 'Base',
    shortName: 'Base',
    vm: 'evm',
    evmChainId: 8453,
    relay: evmRelay(8453, 'base'),
    native: ether(),
    funding: { symbol: 'USDC', label: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, issuer: 'Circle', circleIssued: true, issuerNote: CIRCLE_USDC_NOTE },
    explorer: evmExplorer('Basescan', 'https://basescan.org'),
    rpc: { defaults: ['https://mainnet.base.org'], serverEnv: 'BASE_RPC_URL', browserEnv: 'VITE_BASE_RPC_URL' },
    safeSupported: true,
    rejectedLookalikes: [],
  },
];

/** The primary (default) network. */
export const PRIMARY_NETWORK = 'solana' satisfies NetworkKey;
/** Every supported network in display order, Solana first. */
export const SUPPORTED_NETWORKS: readonly Network[] = deepFreeze([SOLANA_NETWORK, ...EVM_LIST]);
/** Supported EVM networks in display order: Ethereum, BNB Smart Chain, Robinhood Chain, Base. */
export const SUPPORTED_EVM_NETWORKS: readonly EvmNetwork[] = deepFreeze(SUPPORTED_NETWORKS.filter((network): network is EvmNetwork => network.vm === 'evm'));
export const NETWORK_KEYS: readonly NetworkKey[] = deepFreeze(SUPPORTED_NETWORKS.map(network => network.key));
export const SUPPORTED_EVM_CHAIN_IDS: readonly SupportedEvmChainId[] = deepFreeze(SUPPORTED_EVM_NETWORKS.map(network => network.evmChainId));
export const SUPPORTED_RELAY_CHAIN_IDS: readonly SupportedRelayChainId[] = deepFreeze(SUPPORTED_NETWORKS.map(network => network.relay.chainId));

export function isNetworkKey(value: unknown): value is NetworkKey {
  return typeof value === 'string' && SUPPORTED_NETWORKS.some(network => network.key === value);
}
export function isEvmNetwork(network: Network): network is EvmNetwork {
  return network.vm === 'evm';
}
export function byKey(key: 'solana'): SolanaNetwork;
export function byKey(key: EvmNetworkKey): EvmNetwork;
export function byKey(key: NetworkKey): Network;
export function byKey(key: NetworkKey): Network {
  const network = SUPPORTED_NETWORKS.find(item => item.key === key);
  if (!network) throw new Error('This network is not supported by ANTARA.');
  return network;
}
/** Supported EVM network for an EIP-155 chain id; undefined for legacy or unknown ids. */
export function byEvmChainId(chainId: number): EvmNetwork | undefined {
  return SUPPORTED_EVM_NETWORKS.find(network => network.evmChainId === chainId);
}
/** Supported network for a Relay chain id (EVM ids equal their EIP-155 ids). */
export function byRelayChainId(chainId: number): Network | undefined {
  return SUPPORTED_NETWORKS.find(network => network.relay.chainId === chainId);
}
/** True only for a supported network key or a supported Relay chain id. Legacy networks are not supported. */
export function isSupported(value: unknown): boolean {
  return isNetworkKey(value) || (typeof value === 'number' && byRelayChainId(value) !== undefined);
}
/** Fail-closed lookup by key or Relay chain id. */
export function requireNetwork(value: string | number): Network {
  const network = typeof value === 'number' ? byRelayChainId(value) : isNetworkKey(value) ? byKey(value) : undefined;
  if (!network) throw new Error('This network is not supported by ANTARA.');
  return network;
}

/** EVM addresses compare case-insensitively; Solana base58 addresses compare exactly. */
export function sameNetworkAddress(network: Pick<Network, 'vm'>, a: string, b: string): boolean {
  return network.vm === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** True only for the network's pinned funding stablecoin, never for a token that merely shares its ticker. */
export function isFundingToken(network: Network, address: string): boolean {
  return sameNetworkAddress(network, network.funding.address, address)
    && !network.rejectedLookalikes.some(item => sameNetworkAddress(network, item, address));
}

export type EnvSource = Readonly<Record<string, unknown>>;
/**
 * RPC URL for `network`: the configured override for `side`, else the pinned
 * default for that side. A configured value that is not an http(s) URL throws instead of
 * silently falling back, and the message never echoes the value (it may hold a key).
 */
export function rpcUrlFor(network: Network, env: EnvSource, side: 'server' | 'browser', options: { solanaCluster?: SolanaCluster } = {}): string {
  const name = side === 'server' ? network.rpc.serverEnv : network.rpc.browserEnv;
  const configured = typeof env[name] === 'string' ? (env[name] as string).trim() : '';
  if (!configured) {
    if (network.key === 'solana' && options.solanaCluster === 'devnet') return SOLANA_DEVNET_RPC_URL;
    return side === 'browser' ? network.rpc.browserDefault ?? network.rpc.defaults[0] : network.rpc.defaults[0];
  }
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error(`${name} is not a valid RPC URL.`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must be an http(s) RPC URL.`);
  return configured;
}

export type LegacyNetworkKey = 'arbitrum' | 'polygon';
/** Read-only display metadata for a network ANTARA no longer supports. */
export interface LegacyNetwork {
  readonly key: LegacyNetworkKey;
  readonly name: string;
  /** Always marks the network as unsupported. */
  readonly label: string;
  readonly status: 'legacy-unsupported';
  readonly selectable: false;
  readonly vm: 'evm';
  readonly evmChainId: 42161 | 137;
  readonly relay: { readonly chainId: 42161 | 137; readonly slug: 'arbitrum' | 'polygon' };
  readonly native: { readonly symbol: string; readonly name: string; readonly decimals: number };
  /** Circle USDC as previously recorded on this chain; display only. */
  readonly usdc: { readonly symbol: 'USDC'; readonly address: string; readonly decimals: 6 };
  readonly explorer: NetworkExplorer;
}
export const LEGACY_NETWORKS: readonly LegacyNetwork[] = deepFreeze<readonly LegacyNetwork[]>([
  {
    key: 'arbitrum',
    name: 'Arbitrum',
    label: 'Arbitrum (no longer supported)',
    status: 'legacy-unsupported',
    selectable: false,
    vm: 'evm',
    evmChainId: 42161,
    relay: { chainId: 42161, slug: 'arbitrum' },
    native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    usdc: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    explorer: evmExplorer('Arbiscan', 'https://arbiscan.io'),
  },
  {
    key: 'polygon',
    name: 'Polygon',
    label: 'Polygon (no longer supported)',
    status: 'legacy-unsupported',
    selectable: false,
    vm: 'evm',
    evmChainId: 137,
    relay: { chainId: 137, slug: 'polygon' },
    native: { symbol: 'POL', name: 'POL', decimals: 18 },
    usdc: { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    explorer: evmExplorer('Polygonscan', 'https://polygonscan.com'),
  },
]);
/** Legacy metadata for a no-longer-supported chain id (Relay and EVM ids coincide), else undefined. */
export function describeLegacyChain(chainId: number): LegacyNetwork | undefined {
  return LEGACY_NETWORKS.find(network => network.evmChainId === chainId);
}
export function isLegacyChainId(chainId: number): boolean {
  return describeLegacyChain(chainId) !== undefined;
}
export function isLegacyNetworkKey(value: unknown): value is LegacyNetworkKey {
  return typeof value === 'string' && LEGACY_NETWORKS.some(network => network.key === value);
}

export type ChainDescription =
  | { readonly status: 'supported'; readonly chainId: number; readonly name: string; readonly label: string; readonly network: Network }
  | { readonly status: 'legacy'; readonly chainId: number; readonly name: string; readonly label: string; readonly legacy: LegacyNetwork }
  | { readonly status: 'unknown'; readonly chainId: number; readonly name: string; readonly label: string };
/** Read-only description of any Relay chain id, for rendering saved records without throwing. */
export function describeChainId(chainId: number): ChainDescription {
  const network = byRelayChainId(chainId);
  if (network) return { status: 'supported', chainId, name: network.name, label: network.name, network };
  const legacy = describeLegacyChain(chainId);
  if (legacy) return { status: 'legacy', chainId, name: legacy.name, label: legacy.label, legacy };
  const label = Number.isSafeInteger(chainId) ? `Unknown network (${chainId})` : 'Unknown network';
  return { status: 'unknown', chainId, name: 'Unknown network', label };
}

type ExplorerTarget = Pick<Network, 'key' | 'explorer'> | Pick<LegacyNetwork, 'key' | 'explorer'>;
const clusterSuffix = (target: ExplorerTarget, cluster?: SolanaCluster) => target.key === 'solana' && cluster === 'devnet' ? '?cluster=devnet' : '';
export function explorerTxUrl(target: ExplorerTarget, hash: string, options: { solanaCluster?: SolanaCluster } = {}): string {
  return `${target.explorer.tx}${encodeURIComponent(hash)}${clusterSuffix(target, options.solanaCluster)}`;
}
export function explorerAddressUrl(target: ExplorerTarget, address: string, options: { solanaCluster?: SolanaCluster } = {}): string {
  return `${target.explorer.address}${encodeURIComponent(address)}${clusterSuffix(target, options.solanaCluster)}`;
}
