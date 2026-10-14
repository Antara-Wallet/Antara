/**
 * Amount rules for Solana vault deposits and releases, checked before anything is built or signed.
 *
 * Solana keeps an account only while it holds at least the rent-exempt minimum for its size. A vault's
 * deposit address is a plain 0-byte account, so a transfer that would leave it, or an empty recipient
 * wallet, with more than zero but less than getMinimumBalanceForRentExemption(0) lamports fails on-chain
 * with InsufficientFundsForRent. The minimum is always read live from Solana (readSolanaRentMinimum),
 * never hardcoded: it was 650,240 lamports on mainnet on 2026-10-13. A release may still empty the vault.
 */
import type { Connection } from '@solana/web3.js';
import { formatExactAmount } from '../relay/model';

export type VaultAsset = 'SOL' | 'USDC';

/**
 * An amount Solana would reject, refused before anything is built or signed. Its message may state wallet or vault
 * balances, so with privacy on the UI shows the matching PRIVATE_* sentence instead.
 */
export class VaultAmountError extends Error {
  constructor(message: string) { super(message); this.name = 'VaultAmountError'; }
}
/** Shown with privacy on instead of an amount problem: it never states a balance. */
export const PRIVATE_DEPOSIT_PROBLEM = 'This amount can’t be deposited. Turn off privacy to see why.';
export const PRIVATE_RELEASE_PROBLEM = 'This amount can’t be released from your vault. Turn off privacy to see why.';
const DECIMALS: Readonly<Record<VaultAsset, number>> = { SOL: 9, USDC: 6 };
/** A stated SOL minimum is rounded up to 0.00001 SOL, so the figure shown is always enough. */
const SOL_DISPLAY_STEP = 10_000n;

/** Exact, ungrouped amount text that an amount input parses back to the same raw value. */
export const exactAmount = (raw: bigint, asset: VaultAsset): string => formatExactAmount(raw.toString(), DECIMALS[asset]);

/** `lamports` rounded up to 0.00001 SOL, as SOL text: 650,240 lamports reads "0.00066". */
export function solMinimumText(lamports: bigint): string {
  const rounded = lamports <= 0n ? 0n : (lamports + SOL_DISPLAY_STEP - 1n) / SOL_DISPLAY_STEP * SOL_DISPLAY_STEP;
  return exactAmount(rounded, 'SOL');
}

/** Solana's live rent-exempt minimum for a 0-byte account, in lamports. Throws on anything but a positive whole number. */
export async function readSolanaRentMinimum(connection: Pick<Connection, 'getMinimumBalanceForRentExemption'>): Promise<bigint> {
  const value = await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Solana returned an invalid minimum account balance. Nothing was signed.');
  return BigInt(value);
}

/** Why a SOL deposit of `amount` into a vault holding `vaultLamports` would fail on-chain, or null. */
export function solDepositProblem(vaultLamports: bigint, amount: bigint, minimum: bigint): string | null {
  if (vaultLamports + amount >= minimum) return null;
  return vaultLamports === 0n
    ? `The first SOL deposit must be at least ${solMinimumText(minimum)} SOL. Solana needs this minimum to open your vault’s account.`
    : `This deposit must be at least ${solMinimumText(minimum - vaultLamports)} SOL so your vault keeps Solana’s minimum balance.`;
}

/**
 * Why a SOL release of `amount` from a vault holding `vaultLamports` would fail on-chain, or null.
 * It must take everything, or leave at least `minimum` behind.
 */
export function solReleaseProblem(vaultLamports: bigint, amount: bigint, minimum: bigint): string | null {
  if (amount > vaultLamports) return `Your vault holds ${exactAmount(vaultLamports, 'SOL')} SOL.`;
  const remaining = vaultLamports - amount;
  if (remaining === 0n || remaining >= minimum) return null;
  const all = exactAmount(vaultLamports, 'SOL');
  const shown = (minimum + SOL_DISPLAY_STEP - 1n) / SOL_DISPLAY_STEP * SOL_DISPLAY_STEP;
  return vaultLamports > shown
    ? `Release all ${all} SOL, or at most ${exactAmount(vaultLamports - shown, 'SOL')} SOL so ${solMinimumText(minimum)} SOL stays in your vault. Solana doesn’t let an account keep less than that unless it is emptied.`
    : `Release all ${all} SOL. Solana doesn’t let your vault keep less than ${solMinimumText(minimum)} SOL unless it is emptied.`;
}

/** Why a SOL release of `amount` to a wallet holding `recipientLamports` would fail on-chain, or null: an empty wallet must receive the minimum. */
export function solRecipientProblem(recipientLamports: bigint, amount: bigint, minimum: bigint): string | null {
  if (recipientLamports + amount >= minimum) return null;
  return recipientLamports === 0n
    ? `The receiving wallet has no SOL yet, so this release must be at least ${solMinimumText(minimum)} SOL.`
    : `This release must be at least ${solMinimumText(minimum - recipientLamports)} SOL so the receiving wallet keeps Solana’s minimum balance.`;
}

export const NO_SOLANA_USDC = 'You have no USDC on Solana in this wallet.';
/** Why a USDC deposit of `amount` would fail: `walletUsdc` is the wallet's canonical USDC balance, null when it has no USDC account. */
export function usdcDepositProblem(walletUsdc: bigint | null, amount: bigint): string | null {
  if (walletUsdc === null || walletUsdc === 0n) return NO_SOLANA_USDC;
  if (amount > walletUsdc) return `This wallet holds ${exactAmount(walletUsdc, 'USDC')} USDC on Solana, less than this deposit.`;
  return null;
}

/**
 * The release form's check against the verified vault balance, or null when the amount can be released.
 * While the SOL minimum is still being read (`minimum` null), only the balance is checked; the release
 * builder reads the minimum again before anything is signed.
 */
export function releaseAmountProblem(asset: VaultAsset, amount: bigint, vaultBalance: bigint, minimum: bigint | null): string | null {
  if (asset === 'SOL' && minimum !== null) return solReleaseProblem(vaultBalance, amount, minimum);
  return amount > vaultBalance ? `Your vault holds ${exactAmount(vaultBalance, asset)} ${asset}.` : null;
}
