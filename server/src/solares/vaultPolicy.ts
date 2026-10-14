/**
 * Server policy for ANTARA paired Solana vaults: when the guardian (G) may add
 * its vote to a release that the user's wallet (U) proposed and approved.
 *
 * Pure and synchronous. The caller supplies the verified Privy user, the stored
 * registration, a fresh on-chain snapshot and a ledger reader; every check runs
 * here and any exception, missing input or unexpected state denies.
 *
 * What this protects: G only votes for a single SOL or canonical-USDC transfer
 * out of a verified 2-of-2 vault, to one of the user's own linked wallets,
 * for a user whose U is a Privy embedded wallet without delegated (server)
 * signing, and within the vault's own release caps when the user has set them
 * (the optional Limits layer; owner decision 2026-10-13: no default cap, no
 * server ceiling, no link-age wait).
 * What it does not do: it cannot stop U from executing once both votes exist,
 * and it cannot protect funds if U itself is compromised (beyond any caps the
 * user set). It also cannot detect a server that signs as U through Privy's
 * user-JWT exchange; see docs/GUARDIAN.md.
 */
import {
  PairedVaultDecodeError, decodePairedMultisig, decodePairedProposal, decodeReleaseIntent, parseTransactionIndex, verifyUsdcDestinationAccount,
  type PairedAsset, type RawSolanaAccount, type ReleaseIntent,
} from '../../../src/solares/paired/solanaDecode';
import type { LedgerEntry, PairedVaultRecord } from './vaultStore.js';

/** The rolling window of a user-set daily cap (the Limits layer's "per day" value). */
export const RELEASE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** On-chain state older than this is re-read before any vote. */
export const SNAPSHOT_MAX_AGE_MS = 30_000;

/** One cap per asset in raw units; null means no cap. */
export type AssetCaps = Readonly<Record<PairedAsset, bigint | null>>;
/** Release caps in force for one vault. Every value is null unless the user set it through the Limits layer. */
export interface ReleaseLimits { perRelease: AssetCaps; perDay: AssetCaps }
const DECIMALS: Readonly<Record<PairedAsset, number>> = { SOL: 9, USDC: 6 };
/** No cap at all: the default for every vault (the Limits layer is off until the user sets a cap). */
export const NO_RELEASE_LIMITS: ReleaseLimits = Object.freeze({
  perRelease: Object.freeze({ SOL: null, USDC: null }),
  perDay: Object.freeze({ SOL: null, USDC: null }),
});

export function formatRawAmount(raw: bigint, asset: PairedAsset): string {
  const decimals = DECIMALS[asset];
  const digits = raw.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''} ${asset}`;
}

/** Raw cap text as the Limits layer stores it: a positive whole number of raw units, or null for no cap. */
export type RawCap = string | null;
/** A vault's own release caps (raw units), set through the optional Limits layer; null values are "no cap". */
export interface VaultReleaseLimits { perReleaseRaw: Readonly<Record<PairedAsset, RawCap>>; perDayRaw: Readonly<Record<PairedAsset, RawCap>> }
const RAW_CAP = /^[1-9]\d{0,30}$/;
/**
 * The caps in force for one vault: exactly the ones the user set through the
 * Limits layer, and none when the layer is off (owner decision 2026-10-13:
 * there is no server default and no server ceiling). A malformed stored value
 * throws, and the caller denies.
 */
export function effectiveReleaseLimits(vault: VaultReleaseLimits | null | undefined): ReleaseLimits {
  if (!vault) return NO_RELEASE_LIMITS;
  const cap = (kind: 'perReleaseRaw' | 'perDayRaw', asset: PairedAsset): bigint | null => {
    const text = vault[kind]?.[asset];
    if (text === null) return null;
    if (typeof text !== 'string' || !RAW_CAP.test(text)) throw new Error(`Release limits for ${asset} are invalid.`);
    return BigInt(text);
  };
  const limits: ReleaseLimits = {
    perRelease: { SOL: cap('perReleaseRaw', 'SOL'), USDC: cap('perReleaseRaw', 'USDC') },
    perDay: { SOL: cap('perDayRaw', 'SOL'), USDC: cap('perDayRaw', 'USDC') },
  };
  assertLimits(limits);
  return limits;
}
/** True when at least one cap is set. */
export const hasReleaseCap = (limits: ReleaseLimits): boolean =>
  (['perRelease', 'perDay'] as const).some(kind => limits[kind].SOL !== null || limits[kind].USDC !== null);
/** Raw-unit text of caps for the wire and the store; null stays null (no cap). */
export function rawCaps(limits: ReleaseLimits): VaultReleaseLimits {
  const text = (value: bigint | null) => value === null ? null : value.toString();
  return {
    perReleaseRaw: { SOL: text(limits.perRelease.SOL), USDC: text(limits.perRelease.USDC) },
    perDayRaw: { SOL: text(limits.perDay.SOL), USDC: text(limits.perDay.USDC) },
  };
}
function assertLimits(limits: ReleaseLimits) {
  for (const kind of ['perRelease', 'perDay'] as const) {
    for (const asset of ['SOL', 'USDC'] as const) {
      const value = limits?.[kind]?.[asset];
      if (value !== null && (typeof value !== 'bigint' || value <= 0n)) throw new Error(`Release limits for ${asset} are invalid.`);
    }
  }
}

/** The subset of a Privy user that the policy relies on, fetched fresh from Privy by the server. */
export interface LinkedSolanaWallet {
  address: string;
  embedded: boolean;
  /**
   * Embedded wallets only: Privy's `delegated` flag (the app or a server session
   * can sign with it). null when Privy did not report a boolean. Always false
   * for external wallets, which Privy cannot sign with.
   */
  delegated: boolean | null;
  /** Embedded wallets only: the key was imported rather than generated by Privy. */
  imported: boolean;
  /** Privy's `user_can_sign` (whether the user can sign unilaterally); null when not reported. */
  userCanSign: boolean | null;
}
/**
 * The Privy facts a vault decision uses. Owner decision 2026-10-13: there is no MFA on the regular
 * wallet, so Privy `mfa_methods` are not read; the vault's own authenticator is the MFA layer
 * (layers/totp.ts), checked with the other protection layers.
 */
export interface PrivyUserFacts { id: string; solanaWallets: LinkedSolanaWallet[] }
interface PrivyAccountLike {
  type?: unknown; chain_type?: unknown; address?: unknown;
  connector_type?: unknown; wallet_client_type?: unknown; delegated?: unknown; imported?: unknown; user_can_sign?: unknown;
}
export interface PrivyUserLike { id: string; linked_accounts: ReadonlyArray<object>; mfa_methods?: ReadonlyArray<object> | null }
/**
 * Converts a Privy user (from `users()._get`) into policy facts. Every linked
 * Solana wallet can receive releases as soon as it is linked (owner decision
 * 2026-10-13 removed the 24-hour link-age wait), so link times are not read.
 */
export function privyUserFacts(user: PrivyUserLike): PrivyUserFacts {
  if (!user || typeof user.id !== 'string' || !user.id || !Array.isArray(user.linked_accounts)) throw new Error('The Privy user record is incomplete.');
  const solanaWallets = (user.linked_accounts as PrivyAccountLike[]).flatMap((account): LinkedSolanaWallet[] => {
    if (account?.type !== 'wallet' || account.chain_type !== 'solana' || typeof account.address !== 'string') return [];
    const embedded = account.connector_type === 'embedded' && account.wallet_client_type === 'privy';
    return [{
      address: account.address,
      embedded,
      delegated: embedded ? (typeof account.delegated === 'boolean' ? account.delegated : null) : false,
      imported: embedded && account.imported === true,
      userCanSign: typeof account.user_can_sign === 'boolean' ? account.user_can_sign : null,
    }];
  });
  return { id: user.id, solanaWallets };
}

/**
 * Why `wallet` cannot be U, or null. U must be the user's own Privy embedded
 * wallet that only the user can sign with: a delegated wallet (or one Privy
 * says the user cannot sign alone) would let a server act as U, and then the
 * 2-of-2 would no longer need the user.
 */
export function pairedWalletProblem(wallet: LinkedSolanaWallet): string | null {
  if (!wallet.embedded) return 'Paired vaults use your ANTARA (Privy) embedded Solana wallet.';
  if (wallet.delegated === true) return 'Your ANTARA wallet allows delegated (server) signing. Revoke it before using a paired vault, because a server could then sign as you.';
  if (wallet.delegated !== false) return 'ANTARA could not confirm that only you can sign with your wallet. Nothing was changed.';
  if (wallet.userCanSign === false) return 'Privy reports that you cannot sign with your ANTARA wallet on your own, so it cannot pair a vault.';
  return null;
}

export interface OnchainSnapshot {
  /** When the accounts were read (ms). */
  observedAt: number;
  multisig: RawSolanaAccount | null;
  proposal?: RawSolanaAccount | null;
  transaction?: RawSolanaAccount | null;
  /** Spending-limit accounts found for the multisig; null if the check did not run. */
  spendingLimitCount: number | null;
  /** Recipient's USDC token account, read for USDC releases. */
  destinationTokenAccount?: RawSolanaAccount | null;
  /** Lamports at the vault's deposit address, read fresh for a release; null or absent when the read did not succeed. */
  vaultLamports?: bigint | null;
  /** Solana's live rent-exempt minimum for a 0-byte account (getMinimumBalanceForRentExemption(0)); never a constant. */
  rentExemptMinimum?: bigint | null;
}
export type PolicyDenial = { allow: false; alreadyApproved?: false; reason: string; status: 403 | 409 | 503 };

function deny(reason: string, status: PolicyDenial['status'] = 403): PolicyDenial { return { allow: false, reason, status }; }
function denialFrom(error: unknown): PolicyDenial {
  // Decoder messages are ANTARA's own text; anything else stays generic.
  return error instanceof PairedVaultDecodeError ? deny(error.message) : deny('The release could not be verified. Nothing was approved.', 503);
}
function freshSnapshot(onchain: OnchainSnapshot | null | undefined, now: number) {
  if (!onchain || typeof onchain.observedAt !== 'number' || !Number.isFinite(now)) return false;
  return onchain.observedAt <= now + 1_000 && now - onchain.observedAt <= SNAPSHOT_MAX_AGE_MS;
}

export interface RegistrationInput {
  user: PrivyUserFacts;
  guardian: string;
  request: { multisig: string };
  onchain: OnchainSnapshot;
  now: number;
}
export type RegistrationDecision = { allow: true; record: PairedVaultRecord } | PolicyDenial;

/** Registers only an exact paired vault whose U is this user's own Privy embedded Solana wallet. */
export function evaluateRegistration(input: RegistrationInput): RegistrationDecision {
  try {
    const { user, guardian, request, onchain, now } = input;
    if (!user?.id) return deny('A verified ANTARA session is required.');
    if (!freshSnapshot(onchain, now)) return deny('The vault could not be read from the network. Try again.', 503);
    if (onchain.multisig?.address !== request?.multisig) return deny('The vault read does not match the request.', 503);
    const state = decodePairedMultisig(onchain.multisig, { guardian, spendingLimitCount: onchain.spendingLimitCount });
    const wallet = user.solanaWallets.find(item => item.address === state.user);
    if (!wallet) return deny('This vault is not paired with a wallet linked to your account.');
    const problem = pairedWalletProblem(wallet);
    if (problem) return deny(problem);
    return { allow: true, record: { privyUserId: user.id, user: state.user, multisig: state.address, guardian: state.guardian, vault: state.vault, createdAt: new Date(now).toISOString() } };
  } catch (error) { return denialFrom(error); }
}

export interface ReleaseEvaluationInput {
  user: PrivyUserFacts;
  guardian: string;
  registration: PairedVaultRecord | null;
  request: { multisig: string; transactionIndex: string };
  onchain: OnchainSnapshot;
  /** The vault's own caps (the Limits layer); NO_RELEASE_LIMITS when the user set none. */
  limits: ReleaseLimits;
  /** Reads the approval ledger; throwing (unreadable storage) denies. */
  ledger: () => readonly LedgerEntry[];
  now: number;
}
export type ReleaseDecision =
  | { allow: true; intent: ReleaseIntent; entry: LedgerEntry; usedToday: bigint }
  | { allow: false; alreadyApproved: true; reason: string }
  | PolicyDenial;

/**
 * Sum of one vault's reserved approvals of `asset` for this user in the trailing
 * window (future-dated entries count). A daily cap is the vault's own setting,
 * so only that vault's releases count toward it.
 */
export function usageInWindow(ledger: readonly LedgerEntry[], owner: { privyUserId: string; multisig: string }, asset: PairedAsset, now: number, exclude?: { multisig: string; transactionIndex: string }): bigint {
  let total = 0n;
  for (const entry of ledger) {
    if (entry.privyUserId !== owner.privyUserId || entry.multisig !== owner.multisig || entry.asset !== asset) continue;
    if (exclude && entry.multisig === exclude.multisig && entry.transactionIndex === exclude.transactionIndex) continue;
    const at = Date.parse(entry.approvedAt);
    if (!Number.isFinite(at)) throw new Error('Ledger entry has an invalid time.');
    if (now - at < RELEASE_WINDOW_MS) total += BigInt(entry.amountRaw);
  }
  return total;
}

/** Number of this user's reserved approvals (any asset) in the trailing `windowMs`, excluding one proposal. */
export function approvalsInWindow(ledger: readonly LedgerEntry[], privyUserId: string, now: number, windowMs: number, exclude?: { multisig: string; transactionIndex: string }): number {
  let count = 0;
  for (const entry of ledger) {
    if (entry.privyUserId !== privyUserId) continue;
    if (exclude && entry.multisig === exclude.multisig && entry.transactionIndex === exclude.transactionIndex) continue;
    const at = Date.parse(entry.approvedAt);
    if (!Number.isFinite(at)) throw new Error('Ledger entry has an invalid time.');
    if (now - at < windowMs) count += 1;
  }
  return count;
}

/**
 * A SOL release must empty the vault's deposit address or leave at least Solana's rent-exempt minimum there:
 * anything in between passes both votes and then fails at execution (InsufficientFundsForRent). Unread values
 * deny (503). A release larger than the vault's balance is refused too, because it cannot execute.
 */
export function solReleaseBalanceDenial(amountRaw: bigint, vaultLamports: bigint | null | undefined, rentExemptMinimum: bigint | null | undefined): PolicyDenial | null {
  if (typeof vaultLamports !== 'bigint' || typeof rentExemptMinimum !== 'bigint' || vaultLamports < 0n || rentExemptMinimum <= 0n) {
    return deny('The vault balance could not be read from the network. Nothing was approved. Try again.', 503);
  }
  if (amountRaw > vaultLamports) return deny(`The vault holds ${formatRawAmount(vaultLamports, 'SOL')}, less than this release. Nothing was approved.`, 409);
  const remaining = vaultLamports - amountRaw;
  if (remaining > 0n && remaining < rentExemptMinimum) {
    return deny(`This release would leave ${formatRawAmount(remaining, 'SOL')} in the vault, below Solana’s ${formatRawAmount(rentExemptMinimum, 'SOL')} account minimum. Release all of it or leave at least that minimum. Nothing was approved.`, 409);
  }
  return null;
}

export function evaluateRelease(input: ReleaseEvaluationInput): ReleaseDecision {
  try {
    const { user, guardian, registration, request, onchain, limits, now } = input;
    assertLimits(limits);
    // 1. Identity: a verified session, a vault registered to this user, and U still linked to it.
    if (!user?.id) return deny('A verified ANTARA session is required.');
    if (!registration || registration.multisig !== request?.multisig) return deny('This vault is not registered with ANTARA. Activate it again.', 409);
    if (registration.privyUserId !== user.id) return deny('This vault belongs to another account.');
    if (registration.guardian !== guardian) return deny('This vault was paired with a previous ANTARA guardian.', 409);
    const vaultWallet = user.solanaWallets.find(wallet => wallet.address === registration.user);
    if (!vaultWallet) return deny('The vault wallet is no longer linked to your account.');
    // Re-checked on every release: delegation can be granted after registration.
    const problem = pairedWalletProblem(vaultWallet);
    if (problem) return deny(problem);
    // 2. A second factor is the vault's own authenticator (MFA layer), checked by the layer service when it is on.
    // 3. Fresh, exact on-chain state.
    const index = parseTransactionIndex(request.transactionIndex);
    if (!freshSnapshot(onchain, now)) return deny('The vault could not be read from the network. Try again.', 503);
    if (onchain.multisig?.address !== request.multisig) return deny('The vault read does not match the request.', 503);
    const vault = decodePairedMultisig(onchain.multisig, { guardian, user: registration.user, spendingLimitCount: onchain.spendingLimitCount });
    if (vault.vault !== registration.vault) return deny('The vault deposit address changed.');
    if (index > vault.transactionIndex) return deny('This proposal does not exist yet.');
    if (index <= vault.staleTransactionIndex) return deny('This proposal is stale and can no longer be approved.');
    // 4. Proposal votes. A repeated request after G voted is answered, never re-signed.
    const proposal = decodePairedProposal(onchain.proposal, vault, index);
    if (proposal.approved.includes(guardian)) return { allow: false, alreadyApproved: true, reason: 'The ANTARA guardian has already approved this release.' };
    if (proposal.status !== 'Active') return deny('This proposal is not open for approval.');
    if (proposal.rejected.length || proposal.cancelled.length) return deny('This proposal has been rejected or cancelled.');
    if (proposal.approved.length !== 1 || proposal.approved[0] !== vault.user) return deny('Approve the release with your wallet before asking ANTARA to co-sign.');
    // 5. Exact payload: one SOL or USDC transfer out of the vault.
    const candidates = user.solanaWallets.map(wallet => wallet.address);
    const intent = decodeReleaseIntent(onchain.transaction, vault, index, { recipientCandidates: candidates });
    // 6. Recipient: one of the user's own linked wallets (usable as soon as it is linked).
    const recipient = user.solanaWallets.find(wallet => wallet.address === intent.recipient);
    if (!recipient) return deny('Vault releases can only go to a wallet linked to your account.');
    if (intent.asset === 'USDC') verifyUsdcDestinationAccount(onchain.destinationTokenAccount, intent);
    // 6b. A SOL release that would leave the vault below Solana's account minimum (but not empty) cannot execute.
    if (intent.asset === 'SOL') {
      const balanceDenial = solReleaseBalanceDenial(intent.amountRaw, onchain.vaultLamports, onchain.rentExemptMinimum);
      if (balanceDenial) return balanceDenial;
    }
    // 7. The vault's own caps, only when the user set them (Limits layer); unreadable storage throws and denies.
    const perRelease = limits.perRelease[intent.asset], perDay = limits.perDay[intent.asset];
    if (perRelease !== null && intent.amountRaw > perRelease) return deny(`This release exceeds the ${formatRawAmount(perRelease, intent.asset)} per-release limit you set for this vault.`);
    const transactionIndex = index.toString();
    const ledger = input.ledger();
    if (!Array.isArray(ledger)) return deny('The approval ledger is unavailable. Nothing was approved.', 503);
    const existing = ledger.find(entry => entry.multisig === vault.address && entry.transactionIndex === transactionIndex);
    if (existing && (existing.privyUserId !== user.id || existing.asset !== intent.asset || existing.amountRaw !== intent.amountRaw.toString() || existing.recipient !== intent.recipient)) {
      return deny('A different approval is already recorded for this proposal.', 409);
    }
    const used = usageInWindow(ledger, { privyUserId: user.id, multisig: vault.address }, intent.asset, now, { multisig: vault.address, transactionIndex });
    if (perDay !== null && used + intent.amountRaw > perDay) {
      const remaining = perDay > used ? perDay - used : 0n;
      return deny(`This release exceeds the daily limit you set for this vault. ${formatRawAmount(remaining, intent.asset)} remains available now.`);
    }
    const entry: LedgerEntry = existing ?? {
      multisig: vault.address, transactionIndex, privyUserId: user.id, asset: intent.asset,
      amountRaw: intent.amountRaw.toString(), recipient: intent.recipient, approvedAt: new Date(now).toISOString(),
    };
    return { allow: true, intent, entry, usedToday: used };
  } catch (error) {
    if (error instanceof Error && /^Release limits/.test(error.message)) return deny('Vault limits are misconfigured. Nothing was approved.', 503);
    return denialFrom(error);
  }
}
