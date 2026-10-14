/**
 * The vault summary as Receive, Send and the address book read it
 * (docs/UI_ARGUS_PARITY.md 8.2). Area D's `vaults/summary.ts` owns the real
 * `PairedVaultSummary`; until it lands, these screens take it as an optional prop with
 * this structural type, so `usePairedVaultSummary()` can be passed straight in by the
 * shell. Without a summary nothing here claims a vault state: the vault side reads as
 * "Finding your vault" and no address is shown or recognised.
 *
 * Pure: no React, no storage, no network.
 */
import { layerGate, type LayerGate, type VaultLayersLoad } from '../layers/gate';

/** Structural copy of PairedVaultSummary (8.2). Keep in step with vaults/summary.ts. */
export type VaultSummaryInput =
  | { state: 'signed-out' | 'loading' | 'no-pin' | 'not-provisioned' }
  | { state: 'unavailable'; message: string }
  | { state: 'not-activated'; reason: 'activate' | 'pending' | 'mfa' | 'wallet' | 'previous' }
  | { state: 'registered'; stage: 'checking' | 'unavailable' | 'activate-passkey'; multisig: string; depositAddress: string; layers: VaultLayersLoad }
  | { state: 'active'; multisig: string; depositAddress: string; gate: LayerGate; layers: VaultLayersLoad; releaseBlock: string };

/**
 * The 6.6 vault state titles, verbatim (PairedSolanaVault.tsx keeps the originals).
 * Shown where a vault address would be, when the vault cannot take deposits yet.
 */
export const VAULT_STATE_TITLES = Object.freeze({
  'signed-out': 'Your wallet. Its own vault.',
  loading: 'Finding your vault',
  error: 'We couldn’t check your vault',
  'no-pin': 'Vault protection isn’t available in this build',
  'not-provisioned': 'Vault protection isn’t switched on yet',
  wallet: 'Use your ANTARA wallet for the vault',
  mfa: 'Add an authenticator app first',
  previous: 'Your vault uses a previous ANTARA guardian',
  activate: 'Activate your Solana vault',
  pending: 'Finish activating your vault',
  passkey: 'Add a passkey to finish activating',
  passkeyPending: 'Your vault’s first passkey is pending',
  layers: 'We couldn’t check your vault’s protection',
  checking: 'Checking your vault’s protection',
} as const);

/** What the vault side of Receive may show: the verified deposit address, or why not. */
export type VaultReceiveState =
  | { kind: 'ready'; address: string; multisig: string }
  | { kind: 'blocked'; title: string; reason: string };

/**
 * Receive on the vault side shows the deposit address only when the summary is
 * `active` (verified on-chain, registered and a ready layer gate) and its gate has no
 * deposit block. Every other state shows a reason and no address (6.7, U8).
 */
export function vaultReceiveState(summary: VaultSummaryInput | null | undefined): VaultReceiveState {
  if (!summary) return { kind: 'blocked', title: VAULT_STATE_TITLES.loading, reason: '' };
  switch (summary.state) {
    case 'active':
      return summary.gate.depositBlock
        ? { kind: 'blocked', title: VAULT_STATE_TITLES.checking, reason: summary.gate.depositBlock }
        : { kind: 'ready', address: summary.depositAddress, multisig: summary.multisig };
    case 'registered': {
      const gate = layerGate(summary.layers);
      const title = summary.stage === 'activate-passkey'
        ? gate.firstPasskeyAt !== null ? VAULT_STATE_TITLES.passkeyPending : VAULT_STATE_TITLES.passkey
        : summary.stage === 'unavailable' ? VAULT_STATE_TITLES.layers : VAULT_STATE_TITLES.checking;
      return { kind: 'blocked', title, reason: gate.depositBlock };
    }
    case 'not-activated':
      return { kind: 'blocked', title: VAULT_STATE_TITLES[summary.reason], reason: '' };
    case 'unavailable':
      return { kind: 'blocked', title: VAULT_STATE_TITLES.error, reason: summary.message };
    default:
      return { kind: 'blocked', title: VAULT_STATE_TITLES[summary.state], reason: '' };
  }
}

/**
 * The vault's own addresses once it is verified and registered (`registered` or
 * `active`). Send uses them to refuse a plain transfer to the vault: a deposit goes
 * through Deposit, which checks the vault first (8.6). `active` says whether the
 * address book may list the vault under "Your wallets" (only when active, 6.9).
 */
export function vaultAddresses(summary: VaultSummaryInput | null | undefined): { depositAddress: string; multisig: string; active: boolean } | null {
  if (!summary || (summary.state !== 'active' && summary.state !== 'registered')) return null;
  return { depositAddress: summary.depositAddress, multisig: summary.multisig, active: summary.state === 'active' };
}
