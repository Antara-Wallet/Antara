// ANTARA API origin, the same VITE_API_BASE the wallet uses (src/solares/wallet/config.ts).
// Empty means same origin: the Vite dev server proxies /api to localhost:8787, and
// packaged desktop/extension builds set an explicit https origin (https://antara.tech).
// Legacy exports below remain for source compatibility and are not Privy signers.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
const BASE = API_BASE;

import { demoRequest, isDemoMode } from "./demo";

export interface PortfolioToken {
  chain: SwapChain;
  tokenAddress: string | null;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  balance: string;
  raw: string;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface Portfolio {
  address: string;
  tokens: PortfolioToken[];
  totalUsd: number;
  live: boolean;
}

export interface Transfer {
  chain: SwapChain;
  hash: string;
  from: string;
  to: string | null;
  direction: "in" | "out";
  asset: string | null;
  value: number | null;
  blockNum: string;
}

async function get<T>(path: string): Promise<T> {
  if (isDemoMode()) return demoRequest<T>("GET", path);
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (isDemoMode()) return demoRequest<T>("POST", path, body);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ? String(json.error) : `backend ${res.status}`);
  return json as T;
}

// Legacy ARK API chains. The server serves only Ethereum and Base here; Polygon
// was removed with the Solana-primary network switch and is rejected server-side.
export type SwapChain = "ethereum" | "base";

export interface SwapQuote {
  chain: SwapChain;
  tokenIn: string;
  tokenOut: string;
  nativeIn: boolean;
  amountIn: string;
  amountOut: string;
  minOut: string;
  feeTier: number;
  slippageBps: number;
  priceImpactBps: number | null;
  gasEstimate: string | null;
}

export interface Permit2TypedData {
  domain: { name: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "PermitSingle";
  message: {
    details: { token: `0x${string}`; amount: string; expiration: number; nonce: number };
    spender: `0x${string}`;
    sigDeadline: string;
  };
}

export interface PermitInput {
  token: `0x${string}`;
  amount: string;
  expiration: number;
  nonce: number;
  spender: `0x${string}`;
  sigDeadline: string;
  signature: `0x${string}`;
}

export type BuildResult =
  | {
      kind: "tx";
      to: `0x${string}`;
      value: string;
      data: `0x${string}`;
      deadline: number;
      quote: SwapQuote;
    }
  | {
      kind: "permit_required";
      needsErc20Approve: boolean;
      approveTx?: { to: `0x${string}`; value: string; data: `0x${string}` };
      permit2: { address: `0x${string}`; typedData: Permit2TypedData };
      quote: SwapQuote;
    };

export interface TxParams {
  chainId: number;
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string;
}

export const getSwapQuote = (
  chain: SwapChain,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageBps = 50
) =>
  get<SwapQuote>(
    `/swap/quote?chain=${chain}&tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&slippageBps=${slippageBps}`
  );

export const buildSwap = (body: {
  chain: SwapChain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  recipient: `0x${string}`;
  slippageBps?: number;
  permit?: PermitInput;
}) => post<BuildResult>("/swap/build", body);

export const getTxParams = (
  chain: SwapChain,
  from: `0x${string}`,
  to: `0x${string}`,
  value: string,
  data: string
) =>
  get<TxParams>(
    `/tx/params?chain=${chain}&from=${from}&to=${to}&value=${value}&data=${data}`
  );

export const broadcastTx = (chain: SwapChain, raw: `0x${string}`) =>
  post<{ hash: `0x${string}` }>("/tx/broadcast", { chain, raw });

export const getTxReceipt = (chain: SwapChain, hash: `0x${string}`) =>
  get<{ receipt: { status: "success" | "reverted"; blockNumber: string } | null }>(
    `/tx/receipt?chain=${chain}&hash=${hash}`
  );

// ---- Vault (Safe smart-account) ----

export interface SafeTxData {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: number;
}

export interface OwnerSignature {
  signer: `0x${string}`;
  data: `0x${string}`; // 65-byte r||s||v from the Rust signer
}

export interface VaultConfig {
  chain: SwapChain;
  owners: `0x${string}`[];
  threshold: number;
  saltNonce?: string;
}

export const predictVault = (cfg: VaultConfig) =>
  post<{ address: `0x${string}` }>("/vault/predict", cfg);

export const buildVaultDeployment = (cfg: VaultConfig) =>
  post<{ safeAddress: `0x${string}`; to: `0x${string}`; value: string; data: `0x${string}` }>(
    "/vault/deploy/build",
    cfg
  );

export const getVaultDeployed = (chain: SwapChain, address: `0x${string}`) =>
  get<{ deployed: boolean }>(`/vault/deployed?chain=${chain}&address=${address}`);

export const buildVaultTx = (body: {
  chain: SwapChain;
  safeAddress: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation?: number;
}) => post<{ safeTxHash: `0x${string}`; safeTxData: SafeTxData }>("/vault/tx/build", body);

export const buildVaultExec = (body: {
  chain: SwapChain;
  safeAddress: `0x${string}`;
  safeTxData: SafeTxData;
  signatures: OwnerSignature[];
}) =>
  post<{ to: `0x${string}`; value: string; data: `0x${string}` }>(
    "/vault/tx/exec/build",
    body
  );

// ---- Multi-owner coordination (Safe Transaction Service) ----

export interface PendingVaultTx {
  safeTxHash: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: number;
  confirmationsRequired: number;
  confirmations: { owner: `0x${string}`; signature: `0x${string}` }[];
  isExecuted: boolean;
  isReady: boolean;
}

export const proposeVaultTx = (body: {
  chain: SwapChain;
  safeAddress: `0x${string}`;
  safeTxHash: `0x${string}`;
  safeTxData: SafeTxData;
  proposer: OwnerSignature;
}) => post<{ ok: true }>("/vault/tx/propose", body);

export const confirmVaultTx = (body: {
  chain: SwapChain;
  safeTxHash: `0x${string}`;
  signature: `0x${string}`;
}) => post<{ ok: true }>("/vault/tx/confirm", body);

export const getVaultTx = (chain: SwapChain, safeTxHash: `0x${string}`) =>
  get<PendingVaultTx>(`/vault/tx?chain=${chain}&safeTxHash=${safeTxHash}`);

export const listPendingVaultTxs = (chain: SwapChain, safeAddress: `0x${string}`) =>
  get<{ pending: PendingVaultTx[] }>(
    `/vault/tx/pending?chain=${chain}&safeAddress=${safeAddress}`
  );

export const getVaultSignatures = (chain: SwapChain, safeTxHash: `0x${string}`) =>
  get<{ signatures: OwnerSignature[] }>(
    `/vault/tx/signatures?chain=${chain}&safeTxHash=${safeTxHash}`
  );

// ---- Legacy co-signer compatibility (not the current Aegis owner model) ----

export interface PolicyFactors {
  geo?: { lat: number; lng: number };
  webauthn?: { verified: boolean };
  usb?: { presentIds: string[] };
  bluetooth?: { presentIds: string[] };
  voice?: { confidence: number };
}

export interface PolicyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CosignResult {
  ok: boolean;
  policy: { ok: boolean; checks: PolicyCheck[] };
  signature?: OwnerSignature;
}

export const getCosigner = () =>
  get<{ enabled: boolean; address?: `0x${string}` }>("/vault/cosigner");

export const cosignVaultTx = (body: {
  chain: SwapChain;
  safeAddress: `0x${string}`;
  safeTxHash: `0x${string}`;
  safeTxData: SafeTxData;
  factors?: PolicyFactors;
  webauthn?: unknown; // WebAuthn assertion (verified server-side) for the Face ID layer
}) => post<CosignResult>("/vault/cosign", body);

// ---- WebAuthn / passkey (Face ID layer) ----

export const webauthnRegistered = (chain: SwapChain, safeAddress: `0x${string}`) =>
  get<{ registered: boolean }>(
    `/vault/webauthn/registered?chain=${chain}&safeAddress=${safeAddress}`
  );

export const webauthnRegisterOptions = (chain: SwapChain, safeAddress: `0x${string}`) =>
  post<unknown>("/vault/webauthn/register/options", { chain, safeAddress });

export const webauthnRegisterVerify = (
  chain: SwapChain,
  safeAddress: `0x${string}`,
  response: unknown
) => post<{ verified: boolean }>("/vault/webauthn/register/verify", { chain, safeAddress, response });

export const webauthnAuthOptions = (
  chain: SwapChain,
  safeAddress: `0x${string}`,
  safeTxHash: string // tx hash, or an intent like "policy-update"
) => post<unknown>("/vault/webauthn/auth/options", { chain, safeAddress, safeTxHash });

// Phone-assisted Face ID: the desktop starts a session (gets a QR url), then polls
// until the phone completes the ceremony on the configured legacy deployment.
export const webauthnPhoneStart = (chain: SwapChain, safeAddress: `0x${string}`) =>
  post<{ token: string; url: string }>("/vault/webauthn/phone/start", { chain, safeAddress });

// Approval bound to a specific transaction; poll returns the signed assertion to
// hand to the co-signer.
export const webauthnPhoneApproveStart = (
  chain: SwapChain,
  safeAddress: `0x${string}`,
  safeTxHash: string
) =>
  post<{ token: string; url: string }>("/vault/webauthn/phone/approve/start", {
    chain,
    safeAddress,
    safeTxHash,
  });

export const webauthnPhonePoll = (token: string) =>
  get<{
    status: "pending" | "done" | "error" | "expired";
    error?: string;
    result?: unknown;
  }>(`/vault/webauthn/phone/poll/${token}`);

// Stored per-vault policy = the security layers enabled at creation.
export interface VaultPolicyConfig {
  requireGeo?: boolean;
  requireWebauthn?: boolean;
  requireUsbKey?: boolean;
  usbDeviceId?: string;
  requireBluetooth?: boolean;
  bluetoothId?: string;
  maxValueWei?: string;
  geofence?: { lat: number; lng: number; radiusM: number };
  allowlist?: `0x${string}`[];
}

export const getVaultPolicy = (chain: SwapChain, safeAddress: `0x${string}`) =>
  get<{ config: VaultPolicyConfig }>(
    `/vault/policy?chain=${chain}&safeAddress=${safeAddress}`
  );

export const setVaultPolicy = (body: {
  chain: SwapChain;
  safeAddress: `0x${string}`;
  config: VaultPolicyConfig;
  factors?: PolicyFactors; // required when changing an already-guarded policy
  webauthn?: unknown;
}) => post<{ ok: true; config: VaultPolicyConfig }>("/vault/policy", body);

// ---- Stealth addresses (ERC-5564): announcement relay ----

export interface StealthAnnouncementItem {
  id: number;
  chain: SwapChain;
  stealthAddress: `0x${string}`;
  ephemeralPub: string;
  viewTag: number;
  ts: number;
}

export const announceStealth = (body: {
  chain: SwapChain;
  stealthAddress: `0x${string}`;
  ephemeralPub: string;
  viewTag: number;
}) => post<{ ok: true; id: number }>("/stealth/announce", body);

export const getStealthAnnouncements = (chain: SwapChain, since = 0, limit = 2000) =>
  get<{ items: StealthAnnouncementItem[]; cursor: number }>(
    `/stealth/announcements?chain=${chain}&since=${since}&limit=${limit}`
  );

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
}

/** Resolve any ERC-20 by address (symbol / decimals / logo), even a new token. */
export const getTokenInfo = (chain: SwapChain, address: string) =>
  get<TokenInfo>(`/token/${chain}/${address}`);

// Archived token-holder gate shape retained for legacy client compatibility.
export interface AgentGate {
  address: string;
  token: string;
  balance: string;
  priceUsd: number;
  usd: number;
  requiredUsd: number;
  ok: boolean;
}

export const getAgentGate = (address: string) =>
  get<AgentGate>(`/agent/gate?address=${address}`);

// Hosted agent chat (Anthropic response shape, kept minimal).
export interface ChatBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
export interface ChatResponse {
  content: ChatBlock[];
  stop_reason: string;
}

export const agentChatCall = (body: {
  ownerAddress: string;
  vaultAddress: string;
  messages: unknown[];
}) => post<ChatResponse>("/agent/chat", body);

export const getPortfolio = (address: string) =>
  get<Portfolio>(`/portfolio/${address}`);

export const getHistory = (address: string) =>
  get<{ transfers: Transfer[] }>(`/history/${address}`);

export type TrenchChain = "base" | "bsc";
export type TrenchType = "new_creation" | "near_completion" | "completed";

export interface TrenchToken {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  logo: string | null;
  launchpad: string | null;
  ageSeconds: number | null;
  marketCap: number | null;
  volume: number | null;
  liquidity: number | null;
  holderCount: number | null;
  progress: number | null;
  top10HolderRate: number | null;
  devHoldRate: number | null;
  sniperCount: number | null;
  sniperHoldRate: number | null;
  insiderRate: number | null;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  isRenounced: boolean | null;
  smartDegenCount: number | null;
  twitter: string | null;
  website: string | null;
  telegram: string | null;
}

export type Trenches = Record<TrenchType, TrenchToken[]>;

// One call returns all three stages (the backend shares a single upstream poll).
export const getTrenches = (chain: TrenchChain, limit = 60) =>
  get<Trenches>(`/trenches/${chain}?limit=${limit}`);

export function formatCompactUsd(n: number | null): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
