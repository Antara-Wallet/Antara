/**
 * One-shot hand-offs into the Vault screen from elsewhere in the app (the Protection page, the
 * home "Your vault" card): "start creating the vault" or "set up this layer". The caller
 * records the intent and navigates to the vault (`#vault` / `#vaultlayers`); PairedSolanaVault
 * takes it once the vault's state is known. It only opens screens: creating the vault still
 * runs the full activation sequence with every confirmation, and a layer still runs its own
 * review and ceremony.
 *
 * Kept in memory (never storage), and dropped after a short time so an old click cannot
 * open a sheet later.
 */
import type { LayerId } from '../layers/types';

export type VaultIntent = { kind: 'create' } | { kind: 'layer'; layer: LayerId };

const LIFETIME_MS = 60_000;
let current: { intent: VaultIntent; at: number } | null = null;

export function requestVaultIntent(intent: VaultIntent, now = Date.now()): void {
  current = { intent, at: now };
}
/** Shortcut for "Create vault" buttons outside the vault screen. */
export const requestVaultCreation = () => requestVaultIntent({ kind: 'create' });

/** Returns the pending intent (if any, and still fresh) and clears it. */
export function takeVaultIntent(now = Date.now()): VaultIntent | null {
  const value = current && now - current.at <= LIFETIME_MS ? current.intent : null;
  current = null;
  return value;
}

/** Reads without clearing (the vault waits until it knows whether the intent applies). */
export function peekVaultIntent(now = Date.now()): VaultIntent | null {
  return current && now - current.at <= LIFETIME_MS ? current.intent : null;
}
