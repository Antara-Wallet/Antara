/**
 * Pure model of the account pill and account sheet (docs/UI_ARGUS_PARITY.md 6.3).
 * The Vault row states only what the vault summary (8.2) reports: it never says
 * "Active" unless the summary is `active`, which requires an on-chain-verified vault
 * and a ready layer gate with an enrolled passkey.
 */
import type { ChipTone } from '../ui/StatusChip';
import { shortAddress } from '../ui/address';
import type { WalletSigner } from '../wallet/types';
import { walletIdentity, type WalletFamily } from '../wallet/walletIdentity';
import type { PairedVaultSummary } from './screens';

export interface VaultRowStatus {
  tone: ChipTone;
  label: string;
}

/** The Vault row's chip under the selected Solana wallet; null when there is no row (signed out). */
export function vaultRowStatus(summary: PairedVaultSummary): VaultRowStatus | null {
  switch (summary.state) {
    case 'signed-out': return null;
    case 'active':
      return summary.releaseBlock
        ? { tone: 'warn', label: 'Active · releases paused' }
        : { tone: 'ok', label: `Active · ${shortAddress(summary.multisig)}` };
    case 'registered':
      return summary.stage === 'activate-passkey' ? { tone: 'warn', label: 'Add a passkey to finish' }
        : summary.stage === 'checking' ? { tone: 'neutral', label: 'Checking…' }
        : { tone: 'neutral', label: 'Status unavailable' };
    case 'not-activated':
      // "Use your ANTARA wallet" only while another wallet is selected; the ANTARA wallet that the
      // server will not pair (summary.problem) is "Not available for this wallet".
      if (summary.reason !== 'wallet') return { tone: 'neutral', label: 'Not activated' };
      return summary.problem
        ? { tone: 'neutral', label: 'Not available for this wallet' }
        : { tone: 'neutral', label: 'Use your ANTARA wallet for the vault' };
    case 'no-pin':
    case 'not-provisioned':
      return { tone: 'neutral', label: 'Not available' };
    case 'unavailable':
      return { tone: 'neutral', label: 'Status unavailable' };
    case 'loading':
    default:
      return { tone: 'neutral', label: 'Checking…' };
  }
}

/**
 * The account sheet's Vault row belongs only under the ANTARA (embedded) Solana wallet: the
 * selected one, else the first. No embedded Solana wallet, no Vault row.
 */
export function vaultHost<T extends { address: string; embedded?: boolean }>(signers: readonly T[], selected: string | null): T | null {
  return signers.find(item => item.embedded && item.address === selected) ?? signers.find(item => item.embedded) ?? null;
}

/**
 * The chip on that Vault row. The summary describes the selected Solana wallet, so it is
 * shown only while the host is selected; otherwise the row asks to select it. Under the
 * ANTARA wallet itself, the summary's "wallet" reason means the server will not pair this
 * wallet (for example delegated signing), so it reads "Not available for this wallet".
 */
export function hostedVaultStatus(summary: PairedVaultSummary, hostSelected: boolean): VaultRowStatus | null {
  if (summary.state === 'signed-out') return null;
  if (!hostSelected) return { tone: 'neutral', label: 'Select to view' };
  if (summary.state === 'not-activated' && summary.reason === 'wallet') return { tone: 'neutral', label: 'Not available for this wallet' };
  return vaultRowStatus(summary);
}

/** The pill's wallet name: "ANTARA wallet" for the embedded wallet, else the wallet's own name; null when unknown. */
export function signerLabel(signers: readonly WalletSigner[], address: string | null, family: WalletFamily): string | null {
  const signer = address ? signers.find(item => item.address === address) : undefined;
  return signer ? walletIdentity(signer, family).label : null;
}

export interface PillInput {
  authenticated: boolean;
  configured: boolean;
  /** The wallet the Wallet screen shows (Solana unless the account is EVM-only or an EVM network is selected). */
  address: string | null;
  /** Connector name of that wallet, when known. */
  name: string | null;
  solanaView: boolean;
}

export interface PillModel {
  /** Accessible name. "Select wallet" and "Sign in to ANTARA" are asserted by the browser specs. */
  ariaLabel: string;
  title: string;
  subtitle: string;
  /** TokenLogo symbol of the network family. */
  logo: 'solana' | 'ethereum';
}

export function pillModel(input: PillInput): PillModel {
  if (!input.authenticated) return { ariaLabel: 'Sign in to ANTARA', title: 'Sign in', subtitle: 'Your ANTARA wallet', logo: 'solana' };
  return {
    ariaLabel: 'Select wallet',
    title: input.name || (input.solanaView ? 'Solana wallet' : 'EVM wallet'),
    subtitle: input.address ? shortAddress(input.address) : 'Wallet loading…',
    logo: input.solanaView ? 'solana' : 'ethereum',
  };
}

/**
 * The network to show after choosing a wallet in the sheet: Solana for a Solana wallet;
 * for an EVM wallet, the EVM network already selected, else Ethereum (existing behaviour).
 */
export function networkAfterSelect<T extends string>(family: 'solana' | 'evm', current: T | 'all'): T | 'solana' | 'ethereum' {
  if (family === 'solana') return 'solana';
  return current !== 'all' && current !== 'solana' ? current : 'ethereum';
}
