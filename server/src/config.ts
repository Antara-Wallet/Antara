import "dotenv/config";
import { SOLANA_DEVNET_RPC_URL, byKey, rpcUrlFor, type EvmNetworkKey, type Network, type SolanaCluster, type SupportedEvmChainId } from "../../src/solares/networks.js";
import { parseClientIpHeader } from "./solares/clientIp.js";

export const PORT = Number(process.env.PORT ?? 8787);
export const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? "";
export const GMGN_API_KEY = process.env.GMGN_API_KEY ?? "";
export const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY ?? "";
// Safe Transaction Service API key (coordinates multi-owner signatures).
export const SAFE_API_KEY = process.env.SAFE_API_KEY ?? "";

// Hosted agent chat: ARK's own LLM key (gated by $ARK holdings).
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
export const hasAnthropic = () => ANTHROPIC_API_KEY.length > 0;

/**
 * ARK co-signer key (vault Member 2). This is the EVM port of ARGUS's backend
 * co-signer: it signs a SafeTx only AFTER the policy engine passes. It NEVER
 * controls funds alone — the vault is 2-of-2, so the user's master key must also
 * sign. Must be a stable key (the vault address derives from it). 0x-prefixed
 * 32-byte hex. Leave empty to disable co-signer vaults.
 */
export const COSIGNER_PRIVATE_KEY = process.env.COSIGNER_PRIVATE_KEY ?? "";

/**
 * Public EIP-55 address of the co-signer above. Read-only paired-vault discovery
 * uses it, so a server without the key never needs one. When unset, discovery
 * derives it from COSIGNER_PRIVATE_KEY (compatibility). A set but invalid value,
 * or one that differs from the configured key's address, disables discovery.
 */
export const COSIGNER_ADDRESS = process.env.COSIGNER_ADDRESS ?? "";

/**
 * Proxy hops whose X-Forwarded-For entries Express may use for req.ip. TRUST_PROXY
 * is a hop count or "false"; unset means one hop in production and none
 * elsewhere. Trusting every proxy ("true") would let any client forge its IP, so
 * it is rejected. req.ip keys per-IP rate limits and the Wi-Fi layer only when no
 * edge header is configured (CLIENT_IP_HEADER below; on Render it is).
 */
export function parseTrustProxy(value: string | undefined, production: boolean): number | false {
  const setting = (value ?? "").trim().toLowerCase();
  if (!setting) return production ? 1 : false;
  if (setting === "false") return false;
  if (/^\d{1,2}$/.test(setting)) return Number(setting) || false;
  throw new Error('TRUST_PROXY must be a proxy hop count (for example 1) or "false". Trusting all proxies is not supported.');
}
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === "production");
/**
 * Edge header that names the client for per-IP rate limits and the Wi-Fi layer
 * (solares/clientIp.ts). Render fronts web services with Cloudflare, which
 * appends to X-Forwarded-For but sets CF-Connecting-IP itself, so a Render web
 * service defaults to cf-connecting-ip; elsewhere it is off and TRUST_PROXY applies.
 */
export const CLIENT_IP_HEADER = parseClientIpHeader(process.env.CLIENT_IP_HEADER, process.env);
export const CLIENT_IP_HEADER_EXPLICIT = !!process.env.CLIENT_IP_HEADER?.trim();

/**
 * WebAuthn relying-party config (the "Face ID" vault layer). RP_ID must be a
 * domain the credential is bound to. `localhost` works for same-device desktop
 * testing only; cross-device phone passkeys (iPhone Face ID / Android) require a
 * REAL public domain you control (set WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN). ORIGIN
 * may be a comma-separated list of allowed origins.
 */
export const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
export const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME ?? "ANTARA Vault";
export const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN ?? "http://localhost:1420";
export const webauthnOrigins = () =>
  WEBAUTHN_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

// Public web origin that hosts the phone enroll/approve pages (the QR target).
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:1420";

export const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
    "http://localhost:1420,http://127.0.0.1:1420,https://tauri.localhost,tauri://localhost,https://antara.tech,https://www.antara.tech,chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Solana cluster for this API process; read per call so tests and reloads see the current value. */
export const solanaCluster = (): SolanaCluster => process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";

/**
 * True only when the operator set a valid dedicated server RPC for `network`.
 * An override that repeats one of the registry's public endpoints (or Solana
 * devnet's) is still the rate-limited public RPC, and a malformed one makes every
 * read on that network fail, so both report false. Only a boolean is ever reported.
 */
export function serverRpcConfigured(network: Network): boolean {
  const value = process.env[network.rpc.serverEnv];
  if (typeof value !== "string" || !value.trim()) return false;
  let configured: string;
  try { configured = new URL(serverRpcUrl(network)).href; } catch { return false; }
  const publicEndpoints = network.key === "solana" ? [...network.rpc.defaults, SOLANA_DEVNET_RPC_URL] : network.rpc.defaults;
  return !publicEndpoints.some((endpoint) => new URL(endpoint).href === configured);
}

/**
 * Server RPC endpoint for `network`: its server-only override (which may carry a
 * provider key), else the registry's official keyless public endpoint. viem's
 * built-in chain defaults are never used because some are third-party gateways.
 * A malformed override throws without echoing its value.
 */
export const serverRpcUrl = (network: Network): string =>
  rpcUrlFor(network, process.env, "server", { solanaCluster: solanaCluster() });

/**
 * Legacy ARK desktop chains: the Alchemy-backed portfolio/history, Uniswap v3
 * swap, Safe vault and passkey routes outside /api/solares (mutations need
 * ANTARA_ENABLE_LEGACY_API). Only Ethereum and Base have pinned Alchemy and
 * Uniswap data here, so BNB Smart Chain and Robinhood Chain fail closed on those
 * routes. The ANTARA wallet API reads every supported network from the shared
 * registry (src/solares/networks.ts). Arbitrum and Polygon are not supported.
 */
export interface Chain {
  /** Our short id used in the API. */
  id: "ethereum" | "base";
  label: string;
  /** Alchemy network slug. */
  alchemyNetwork: string;
  /** DefiLlama chain prefix for token prices. */
  llamaChain: string;
  /** CoinGecko id of the native gas token (for DefiLlama native price lookup). */
  nativeCoingeckoId: string;
  nativeSymbol: string;
  /** Display name of the native asset (e.g. "Ethereum"), NOT the chain. */
  nativeName: string;
  nativeDecimals: number;
}

export const CHAINS: Chain[] = [
  {
    id: "ethereum",
    label: "Ethereum",
    alchemyNetwork: "eth-mainnet",
    llamaChain: "ethereum",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
    nativeName: "Ethereum",
    nativeDecimals: 18,
  },
  {
    id: "base",
    label: "Base",
    alchemyNetwork: "base-mainnet",
    llamaChain: "base",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
    nativeName: "Ethereum",
    nativeDecimals: 18,
  },
];

export const hasAlchemy = () => ALCHEMY_API_KEY.length > 0;
export const hasGmgn = () => GMGN_API_KEY.length > 0;
export const hasSafeApi = () => SAFE_API_KEY.length > 0;
export const hasCosigner = () => /^0x[0-9a-fA-F]{64}$/.test(COSIGNER_PRIVATE_KEY);

/**
 * EIP-155 chain id for each supported EVM network, from the registry (Safe
 * Transaction Service is keyed by it). Arbitrum (42161) and Polygon (137) are
 * not supported and have no entry.
 */
export const CHAIN_IDS: Readonly<Record<EvmNetworkKey, SupportedEvmChainId>> = Object.freeze({
  ethereum: byKey("ethereum").evmChainId,
  bsc: byKey("bsc").evmChainId,
  robinhood: byKey("robinhood").evmChainId,
  base: byKey("base").evmChainId,
});
