/**
 * Pure model of the Wallet home's "Your vault" card (VaultCard.tsx): chip, sentence, activation
 * progress and the one action for each vault summary state (vaults/summary.ts, spec 8.2).
 * No React, so every state is unit-tested (vaultCardModel.test.ts). Nothing here claims more
 * than the summary says: "Active" only for `active`, progress only while activating.
 */
import type { ChipTone } from '../ui/StatusChip';
import type { PairedVaultSummary } from '../vaults/summary';

/** The activation steps the Vault side runs (create on Solana, register, first passkey). */
export const VAULT_STEPS: readonly string[] = Object.freeze(['Create on Solana', 'Register', 'Add a passkey']);
export const VAULT_PITCH = 'A 2-of-2 vault on Solana. Every release needs your approval and ANTARA’s.';

/** Status line, chip and primary action for each summary state. */
export interface VaultCardModel {
  tone: ChipTone;
  chip: string;
  text: string;
  /** Activation progress: index of the current step, or null when not activating. */
  step: number | null;
  /**
   * The card's one action. Every action opens the Vault side; `intent` also asks it to open the
   * create sequence ("create") or the passkey form ("passkey") once the vault's state is known
   * (vaults/vaultIntent.ts). Creating still runs every confirmation on the Vault side.
   */
  action: { label: string; primary: boolean; intent?: 'create' | 'passkey' } | null;
  retry: boolean;
}

export function vaultCardModel(summary: PairedVaultSummary): VaultCardModel {
  switch (summary.state) {
    case 'signed-out':
      return { tone: 'neutral', chip: 'Signed out', text: `${VAULT_PITCH} Sign in to create yours.`, step: null, action: { label: 'Open your vault', primary: false }, retry: false };
    case 'loading':
      return { tone: 'neutral', chip: 'Checking…', text: 'Checking your vault with ANTARA and Solana…', step: null, action: null, retry: false };
    case 'no-pin':
      return { tone: 'neutral', chip: 'Not available', text: 'This build of ANTARA has no vault guardian set up, so vaults cannot be created here.', step: null, action: null, retry: false };
    case 'not-provisioned':
      return { tone: 'neutral', chip: 'Not available', text: 'ANTARA’s vault service is not switched on for this server yet.', step: null, action: null, retry: false };
    case 'unavailable':
      return { tone: 'danger', chip: 'Status unavailable', text: summary.message, step: null, action: { label: 'Open vault', primary: false }, retry: true };
    case 'not-activated':
      switch (summary.reason) {
        case 'pending':
          return { tone: 'warn', chip: 'Activating', text: 'A vault creation was started on this device. Finish it to register the vault.', step: 0, action: { label: 'Finish activation', primary: true, intent: 'create' }, retry: false };
        case 'wallet':
          // The ANTARA wallet itself, refused by the server (summary.problem): say why, never "select it".
          if (summary.problem) return { tone: 'neutral', chip: 'Not available', text: `ANTARA can’t pair a vault with this wallet. ${summary.problem}`, step: null, action: { label: 'Open vault', primary: false }, retry: false };
          return { tone: 'neutral', chip: 'Not created', text: 'Vaults pair with your ANTARA Solana wallet. Select it in the account menu to create one.', step: null, action: { label: 'Open vault', primary: false }, retry: false };
        case 'previous':
          return { tone: 'warn', chip: 'Earlier vault', text: 'Your registered vault uses a previous ANTARA guardian. Open it to see what you can do.', step: null, action: { label: 'Open vault', primary: false }, retry: false };
        default:
          return { tone: 'neutral', chip: 'Not created', text: VAULT_PITCH, step: null, action: { label: 'Create your vault', primary: true, intent: 'create' }, retry: false };
      }
    case 'registered':
      if (summary.stage === 'activate-passkey') {
        return { tone: 'warn', chip: 'Activating', text: 'Your vault is created and registered. A passkey completes activation.', step: 2, action: { label: 'Add a passkey', primary: true, intent: 'passkey' }, retry: false };
      }
      return summary.stage === 'checking'
        ? { tone: 'neutral', chip: 'Checking…', text: 'Reading your vault’s protection layers.', step: null, action: { label: 'Open vault', primary: false }, retry: false }
        : { tone: 'danger', chip: 'Status unavailable', text: 'Your vault is registered, but its protection layers could not be read.', step: null, action: { label: 'Open vault', primary: false }, retry: true };
    case 'active':
      return summary.releaseBlock
        ? { tone: 'warn', chip: 'Releases paused', text: summary.releaseBlock, step: null, action: { label: 'Open vault', primary: false }, retry: false }
        : { tone: 'ok', chip: 'Active', text: 'Verified on Solana. Releases need your approval and ANTARA’s.', step: null, action: { label: 'Open vault', primary: false }, retry: false };
  }
}

