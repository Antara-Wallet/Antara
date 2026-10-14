import { NETWORK_KEYS, PRIMARY_NETWORK, SOLANA_NETWORK, SUPPORTED_EVM_CHAIN_IDS, SUPPORTED_NETWORKS, byKey, rpcUrlFor, type EvmNetworkKey } from '../networks';

/** Reads one build-time value. Outside Vite (Node unit tests) import.meta.env is undefined. */
function read(get: () => string | undefined): string | undefined {
  try { return get(); } catch { return undefined; }
}

/**
 * Every public build value the wallet reads, each named explicitly so Vite inlines
 * only these strings and never the whole import.meta.env object. Add a key here
 * (and to .env.example) before reading a new VITE_ variable; secrets never belong
 * in a VITE_ variable.
 */
export const PUBLIC_ENV = Object.freeze({
  VITE_API_BASE: read(() => import.meta.env.VITE_API_BASE),
  VITE_PRIVY_APP_ID: read(() => import.meta.env.VITE_PRIVY_APP_ID),
  VITE_PRIVY_CLIENT_ID: read(() => import.meta.env.VITE_PRIVY_CLIENT_ID),
  VITE_ANTARA_GUARDIAN_SOLANA: read(() => import.meta.env.VITE_ANTARA_GUARDIAN_SOLANA),
  VITE_SOLANA_CLUSTER: read(() => import.meta.env.VITE_SOLANA_CLUSTER),
  VITE_SOLANA_RPC_URL: read(() => import.meta.env.VITE_SOLANA_RPC_URL),
  VITE_SOLANA_WS_URL: read(() => import.meta.env.VITE_SOLANA_WS_URL),
  VITE_ETHEREUM_RPC_URL: read(() => import.meta.env.VITE_ETHEREUM_RPC_URL),
  VITE_BSC_RPC_URL: read(() => import.meta.env.VITE_BSC_RPC_URL),
  VITE_ROBINHOOD_RPC_URL: read(() => import.meta.env.VITE_ROBINHOOD_RPC_URL),
  VITE_BASE_RPC_URL: read(() => import.meta.env.VITE_BASE_RPC_URL),
});

const env = PUBLIC_ENV;
export const API_URL = (env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');
export const PRIVY_APP_ID = String(env.VITE_PRIVY_APP_ID || '').trim();
/** Optional Privy app client ID (Dashboard > Clients) for this build's platform: web, desktop or extension. Public. */
export const PRIVY_CLIENT_ID = String(env.VITE_PRIVY_CLIENT_ID || '').trim();
/** Public pin of the ANTARA guardian's Solana address for paired vaults; empty when this build has none. */
export const PAIRED_GUARDIAN_SOLANA = String(env.VITE_ANTARA_GUARDIAN_SOLANA || '').trim();
export const SOLANA_CLUSTER = env.VITE_SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
export const SOLANA_CHAIN = SOLANA_CLUSTER === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
const SOLANA_PUBLIC_RPC_URL = String(env.VITE_SOLANA_RPC_URL || rpcUrlFor(SOLANA_NETWORK, {}, 'browser', { solanaCluster: SOLANA_CLUSTER }));
/**
 * ANTARA's same-origin Solana JSON-RPC (server/src/solares/solanaRpcProxy.ts), backed by the
 * server's dedicated RPC. Free public endpoints refuse indexed calls from browsers (publicnode
 * answers getProgramAccounts with 403), so every surface with an API origin uses this instead:
 * the web app (its own origin), the extension and the desktop app (VITE_API_BASE).
 */
export function solanaProxyUrl(apiUrl: string, origin: string | undefined): string | null {
  const base = apiUrl || (origin && /^https?:\/\//.test(origin) ? origin : '');
  return base ? `${base.replace(/\/+$/, '')}/api/solares/rpc/solana` : null;
}
const pageOrigin = typeof location !== 'undefined' ? location.origin : undefined;
/** Browser Solana HTTP RPC: ANTARA's proxy when an API origin exists, else the public VITE_ override or registry default (Node tests). */
export const SOLANA_RPC_URL = solanaProxyUrl(API_URL, pageOrigin) ?? SOLANA_PUBLIC_RPC_URL;
/** Websocket subscriptions (Privy, web3.js) stay on the public endpoint; the proxy is HTTP only. */
export const SOLANA_WS_URL = String(env.VITE_SOLANA_WS_URL || SOLANA_PUBLIC_RPC_URL.replace(/^http/, 'ws'));
/** Circle USDC mint on Solana mainnet: the registry's Solana funding stablecoin. */
export const USDC_SOLANA = SOLANA_NETWORK.funding.address;
// Network list, display order (Solana first) and primary network come from the registry.
export { PRIMARY_NETWORK, NETWORK_KEYS, SUPPORTED_NETWORKS };
/** Supported EVM chain ids in display order: Ethereum, BNB Smart Chain, Robinhood Chain, Base. Arbitrum and Polygon are not supported. */
export const EVM_CHAIN_IDS = SUPPORTED_EVM_CHAIN_IDS;
/** Browser RPC for an EVM network: its public VITE_ override, else the pinned keyless default. Throws on a malformed override. */
export function browserRpcUrl(key: EvmNetworkKey): string {
  return rpcUrlFor(byKey(key), env, 'browser');
}
