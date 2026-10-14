/**
 * Client for ANTARA's paired Solana vault API (/api/solares/paired-vault).
 * Every response is parsed strictly and bound to this build's pinned guardian
 * and Solana cluster: anything unexpected throws, so the wallet never shows a
 * guardian, limit, vault or approval it could not verify.
 */
import { API_URL, PAIRED_GUARDIAN_SOLANA, SOLANA_CLUSTER } from '../wallet/config';
import { PAIRED_POLICY_VERSION, isSolanaAddress, isSolanaWalletAddress, pairedVaultAddresses } from '../paired/solanaDecode';
import { parseLayerRefusal } from '../layers/schema';
import type { LayerEvidence, LayerRequirement, LayerResult } from '../layers/types';

/** Public build pin (VITE_ANTARA_GUARDIAN_SOLANA, read in wallet/config): the only ANTARA guardian this build pairs with. Empty means paired vaults are off in this build. */
export { PAIRED_GUARDIAN_SOLANA };

export type PairedAsset = 'SOL' | 'USDC';
type PerAsset<T> = { SOL: T; USDC: T };
/**
 * The release caps the user set for one vault through the optional Limits layer (raw units). null means no
 * cap, the default: owner decision 2026-10-13 removed every server default, ceiling and minimum.
 */
export interface PairedLimits {
  perRelease: PerAsset<bigint | null>;
  perDay: PerAsset<bigint | null>;
}
export interface PairedGuardianConfig { guardian: string; cluster: 'mainnet-beta' | 'devnet'; policyVersion: string }
export interface PairedAccountWallet {
  address: string;
  embedded: boolean;
  /** Why this wallet cannot be your vault wallet, or null when it can. Every linked wallet can receive releases as soon as it is linked. */
  pairProblem: string | null;
}
export interface PairedVaultRegistration { multisig: string; vault: string; user: string; guardian: string; createdAt: string }
/**
 * A paired vault the server found on Solana for one of your wallets that is not registered yet (created in another
 * app, or its registration never finished). Only a pointer: Finish activation verifies it on-chain before registering.
 */
export interface PairedUnregisteredVault { multisig: string; vault: string; user: string; guardian: string }
export interface PairedAccount {
  mfaEnrolled: boolean; wallets: PairedAccountWallet[]; vaults: PairedVaultRegistration[];
  /** Absent when the server did not (or could not) look on Solana; then nothing is known either way. */
  unregistered?: PairedUnregisteredVault[];
}
/** One vault's caps (none unless the user set them) and what that vault released in the last 24 hours. */
export interface PairedUsage { multisig: string; limits: PairedLimits; usedLast24h: PerAsset<bigint> }
export type PairedApproval =
  | { status: 'approved'; signature: string; asset: PairedAsset; amountRaw: bigint; recipient: string }
  | { status: 'pending'; signature: string }
  | { status: 'already-approved' };

/**
 * A refusal from the vault API. `code` is 'not-provisioned' when the server has no guardian or paired vaults are switched off.
 * Vault layer refusals also carry what is required ('layers-required'), which layers failed ('layer-failed') or when to retry ('locked').
 */
export class PairedVaultApiError extends Error {
  constructor(
    message: string, readonly status: number, readonly code: string,
    readonly required: LayerRequirement[] | null = null, readonly layers: LayerResult[] | null = null, readonly retryAfterSeconds: number | null = null,
  ) { super(message); this.name = 'PairedVaultApiError'; }
}

const invalid = (): never => { throw new Error('The vault service returned an unexpected response. Nothing was changed.'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const RAW = /^(0|[1-9]\d{0,30})$/;
const raw = (value: unknown): bigint => typeof value === 'string' && RAW.test(value) ? BigInt(value) : invalid();
const perAsset = (value: unknown): PerAsset<bigint> => { const item = record(value); return { SOL: raw(item.SOL), USDC: raw(item.USDC) }; };
const CAP = /^[1-9]\d{0,30}$/;
const cap = (value: unknown): bigint | null => value === null ? null : typeof value === 'string' && CAP.test(value) ? BigInt(value) : invalid();
const perAssetCap = (value: unknown): PerAsset<bigint | null> => {
  const item = record(value);
  if (Object.keys(item).sort().join() !== 'SOL,USDC') invalid();
  return { SOL: cap(item.SOL), USDC: cap(item.USDC) };
};
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const iso = (value: unknown): number => {
  const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : invalid();
};
const address = (value: unknown): string => isSolanaAddress(value) ? value : invalid();

/** A vault's caps: each value a positive raw amount or null (no cap); a per-release cap is never above that asset's daily cap. */
export function parsePairedLimits(value: unknown): PairedLimits {
  const item = record(value);
  // Exactly the user's caps: a server field such as a ceiling or minimum is refused, never shown.
  if (Object.keys(item).sort().join() !== 'perDayRaw,perReleaseRaw') invalid();
  const limits = { perRelease: perAssetCap(item.perReleaseRaw), perDay: perAssetCap(item.perDayRaw) };
  for (const asset of ['SOL', 'USDC'] as const) {
    const once = limits.perRelease[asset], day = limits.perDay[asset];
    if (once !== null && day !== null && once > day) invalid();
  }
  return limits;
}
/** True when the user set at least one cap for the vault. */
export const hasPairedCap = (limits: PairedLimits): boolean =>
  limits.perRelease.SOL !== null || limits.perRelease.USDC !== null || limits.perDay.SOL !== null || limits.perDay.USDC !== null;
/** What a release of `asset` may still be under the vault's caps: null where no cap applies. */
export function pairedReleaseBounds(usage: PairedUsage, asset: PairedAsset): { perRelease: bigint | null; remainingToday: bigint | null } {
  const day = usage.limits.perDay[asset], used = usage.usedLast24h[asset];
  return { perRelease: usage.limits.perRelease[asset], remainingToday: day === null ? null : day > used ? day - used : 0n };
}

/** Binds the server's guardian to this build's pin and cluster; a mismatch is refused, never adopted. */
export function parsePairedConfig(value: unknown, pinnedGuardian = PAIRED_GUARDIAN_SOLANA, cluster: string = SOLANA_CLUSTER): PairedGuardianConfig {
  if (!pinnedGuardian) throw new Error('This build has no pinned ANTARA guardian, so paired vaults are unavailable.');
  const item = record(value);
  if (item.configured !== true || !isSolanaWalletAddress(item.guardian)) invalid();
  if (item.guardian !== pinnedGuardian) throw new Error('The ANTARA guardian reported by the server does not match this build. Nothing will be created or approved.');
  if (item.cluster !== cluster) throw new Error('The vault service is on a different Solana cluster than this wallet. Nothing will be created or approved.');
  if (item.policyVersion !== PAIRED_POLICY_VERSION) throw new Error('The vault service uses a different paired-vault policy version. Update ANTARA before continuing.');
  return { guardian: item.guardian as string, cluster: item.cluster as PairedGuardianConfig['cluster'], policyVersion: PAIRED_POLICY_VERSION };
}

export function parsePairedAccount(value: unknown): PairedAccount {
  const item = record(value);
  if (typeof item.mfaEnrolled !== 'boolean' || !Array.isArray(item.wallets) || !Array.isArray(item.vaults) || item.wallets.length > 50 || item.vaults.length > 50) invalid();
  const wallets = (item.wallets as unknown[]).map(entry => {
    const wallet = record(entry);
    if (typeof wallet.embedded !== 'boolean' || (wallet.pairProblem !== null && (typeof wallet.pairProblem !== 'string' || wallet.pairProblem.length > 300))) invalid();
    // An older server may still send `receivesReleasesFrom`; it is ignored: no link-age wait applies.
    return { address: address(wallet.address), embedded: wallet.embedded as boolean, pairProblem: wallet.pairProblem as string | null };
  });
  const vaults = (item.vaults as unknown[]).map(entry => {
    const vault = record(entry);
    const multisig = address(vault.multisig);
    // The deposit address is derived, never trusted from the server.
    if (vault.vault !== pairedVaultAddresses(multisig).vault) invalid();
    iso(vault.createdAt);
    return { multisig, vault: vault.vault as string, user: address(vault.user), guardian: address(vault.guardian), createdAt: vault.createdAt as string };
  });
  if (item.unregistered === undefined) return { mfaEnrolled: item.mfaEnrolled as boolean, wallets, vaults };
  if (!Array.isArray(item.unregistered) || item.unregistered.length > 10) invalid();
  const unregistered = (item.unregistered as unknown[]).map(entry => {
    const found = record(entry);
    const multisig = address(found.multisig);
    // The deposit address is derived, never trusted from the server.
    if (found.vault !== pairedVaultAddresses(multisig).vault) invalid();
    return { multisig, vault: found.vault as string, user: address(found.user), guardian: address(found.guardian) };
  });
  return { mfaEnrolled: item.mfaEnrolled as boolean, wallets, vaults, unregistered };
}

/** Parses GET /limits?multisig= for exactly the requested vault. */
export function parsePairedUsage(value: unknown, multisig: string): PairedUsage {
  const item = record(value);
  if (item.multisig !== multisig) invalid();
  return { multisig, limits: parsePairedLimits(item.limits), usedLast24h: perAsset(item.usedLast24h) };
}

export function parsePairedRegistration(value: unknown, multisig: string, pinnedGuardian = PAIRED_GUARDIAN_SOLANA) {
  const item = record(value);
  if ((item.status !== 'registered' && item.status !== 'already-registered') || item.multisig !== multisig ||
    item.vault !== pairedVaultAddresses(multisig).vault || !pinnedGuardian || item.guardian !== pinnedGuardian) invalid();
  return { status: item.status as 'registered' | 'already-registered', multisig, vault: item.vault as string };
}

export function parsePairedApproval(value: unknown): PairedApproval {
  const item = record(value);
  if (item.status === 'already-approved') return { status: 'already-approved' };
  if (typeof item.signature !== 'string' || !SIGNATURE.test(item.signature)) invalid();
  if (item.status === 'pending') return { status: 'pending', signature: item.signature as string };
  if (item.status !== 'approved' || (item.asset !== 'SOL' && item.asset !== 'USDC')) invalid();
  return { status: 'approved', signature: item.signature as string, asset: item.asset as PairedAsset, amountRaw: raw(item.amountRaw), recipient: address(item.recipient) };
}

/** One call to /api/solares/paired-vault: GET without a body, POST with one. Shared by the vault layer client (layers/api.ts). */
export async function call<T>(path: string, token: string, parse: (value: unknown) => T, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`${API_URL}/api/solares/paired-vault${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const failure = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const message = typeof failure.error === 'string' && failure.error.length <= 400 ? failure.error : 'The vault service is unavailable. Nothing was changed.';
    const code = typeof failure.code === 'string' && failure.code.length <= 40 ? failure.code : 'unavailable';
    const extra = parseLayerRefusal(code, failure, response.headers.get('Retry-After'));
    throw new PairedVaultApiError(message, response.status, code, extra.required, extra.layers, extra.retryAfterSeconds);
  }
  return parse(payload);
}

export const fetchPairedConfig = (token: string, signal?: AbortSignal) => call('/solana/config', token, value => parsePairedConfig(value), { signal });
export const fetchPairedAccount = (token: string, signal?: AbortSignal) => call('/solana/account', token, parsePairedAccount, { signal });
export const fetchPairedUsage = (token: string, multisig: string, signal?: AbortSignal) =>
  call(`/limits?multisig=${encodeURIComponent(multisig)}`, token, value => parsePairedUsage(value, multisig), { signal });
export const registerPairedVault = (token: string, multisig: string) =>
  call('/solana/register', token, value => parsePairedRegistration(value, multisig), { body: { multisig } });
/**
 * Asks the guardian to vote. A repeat answers 'already-approved' once G's vote is on-chain, or
 * 'pending' while a recent vote may still land; after that window a fresh vote transaction may be
 * sent for the same reservation. Squads records G's approval at most once.
 * When the vault has protection layers, the first call answers 403 'layers-required'; the second carries
 * the evidence for the challenge from /solana/layers/approval/begin (docs/VAULT_LAYERS.md section 12).
 */
export const requestGuardianApproval = (token: string, multisig: string, transactionIndex: string, layers?: LayerEvidence) =>
  call('/solana/approve', token, parsePairedApproval, { body: layers ? { multisig, transactionIndex, layers } : { multisig, transactionIndex } });
