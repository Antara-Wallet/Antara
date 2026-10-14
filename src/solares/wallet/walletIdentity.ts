/**
 * Pure model of how a wallet on the account is named and what its settings sheet offers.
 *
 * - The account's Privy embedded wallets (Solana and EVM) are the user's "ANTARA wallet",
 *   never "Privy" / "privy". External wallets keep their own name (Phantom, MetaMask, …)
 *   and are marked "External".
 * - Only an ANTARA (embedded) wallet offers "Export private key", which opens Privy's own
 *   secure export window. ANTARA code never receives, logs, stores or copies the key; this
 *   module only turns Privy's failures into readable text and never echoes raw errors.
 */
import { SOLANA_NETWORK, SUPPORTED_EVM_NETWORKS, explorerAddressUrl, type SolanaCluster } from '../networks';
import type { ExportChain, WalletSigner } from './types';

export type WalletFamily = 'solana' | 'evm';

export const ANTARA_WALLET_NAME = 'ANTARA wallet';

/** Privy's embedded wallet client types ("privy", and "privy-v2" for newer wallets). */
export function isEmbeddedClientType(type: string | null | undefined): boolean {
  return type === 'privy' || type === 'privy-v2';
}

export interface WalletIdentity {
  /** "ANTARA wallet" for the embedded wallet, else the wallet's own name. */
  label: string;
  embedded: boolean;
  /** "External" for a wallet whose keys live in another app; null for the ANTARA wallet. */
  hint: 'External' | null;
  /** The app that holds an external wallet's keys ("Phantom"); null for the ANTARA wallet. */
  app: string | null;
  family: WalletFamily;
}

const FAMILY_FALLBACK: Record<WalletFamily, string> = { solana: 'Solana wallet', evm: 'EVM wallet' };

/** How a wallet row, the pill and the wallet settings sheet name a wallet. */
export function walletIdentity(signer: Pick<WalletSigner, 'name' | 'embedded'>, family: WalletFamily): WalletIdentity {
  if (signer.embedded) return { label: ANTARA_WALLET_NAME, embedded: true, hint: null, app: null, family };
  const name = signer.name.trim() || FAMILY_FALLBACK[family];
  return { label: name, embedded: false, hint: 'External', app: name, family };
}

/** The chain Privy's export hook is opened for. */
export function exportChainFor(family: WalletFamily): ExportChain {
  return family === 'solana' ? 'solana' : 'ethereum';
}

/**
 * The account's own Privy embedded wallets, read only from Privy's linked accounts (the user
 * record from Privy's server): type "wallet", an embedded client type and connector type
 * "embedded", the same facts the API server checks (server/src/solares/wallet.ts). What a
 * connected wallet says about itself is never trusted for this: any extension can set a Wallet
 * Standard `isPrivyWallet`, or announce itself as "Privy" over EIP-6963 (client type "privy").
 * Solana addresses are kept exactly, EVM addresses lowercased.
 */
export interface EmbeddedWallets { solana: ReadonlySet<string>; ethereum: ReadonlySet<string> }

export function embeddedWalletsOf(linkedAccounts: readonly unknown[] | null | undefined): EmbeddedWallets {
  const solana = new Set<string>();
  const ethereum = new Set<string>();
  for (const account of linkedAccounts ?? []) {
    if (!account || typeof account !== 'object') continue;
    const item = account as { type?: unknown; chainType?: unknown; walletClientType?: unknown; connectorType?: unknown; address?: unknown };
    if (item.type !== 'wallet' || typeof item.address !== 'string' || !item.address || item.connectorType !== 'embedded') continue;
    if (!isEmbeddedClientType(typeof item.walletClientType === 'string' ? item.walletClientType : null)) continue;
    if (item.chainType === 'solana') solana.add(item.address);
    else if (item.chainType === 'ethereum') ethereum.add(item.address.toLowerCase());
  }
  return { solana, ethereum };
}

/** True when `address` is one of the account's embedded wallets on `chain` (Solana exact, EVM without case). */
export function isEmbeddedAddress(embedded: EmbeddedWallets, chain: ExportChain, address: string | null | undefined): boolean {
  if (!address) return false;
  return chain === 'solana' ? embedded.solana.has(address) : embedded.ethereum.has(address.toLowerCase());
}

/** A Privy Solana wallet as a signer: embedded only when Privy's linked accounts list it as the account's own wallet. */
export function solanaSigner(wallet: { address: string; standardWallet: { name?: string } }, embedded: EmbeddedWallets): WalletSigner {
  if (isEmbeddedAddress(embedded, 'solana', wallet.address)) return { address: wallet.address, name: ANTARA_WALLET_NAME, embedded: true };
  return { address: wallet.address, name: wallet.standardWallet.name?.trim() || FAMILY_FALLBACK.solana, embedded: false };
}

/** True for Privy's own embedded EVM connector whose address Privy's linked accounts list as embedded. */
export function isEmbeddedEvmWallet(wallet: { address: string; walletClientType?: string | null; connectorType?: string | null }, embedded: EmbeddedWallets): boolean {
  return isEmbeddedClientType(wallet.walletClientType) && wallet.connectorType === 'embedded' && isEmbeddedAddress(embedded, 'ethereum', wallet.address);
}

/** A Privy EVM wallet as a signer: the connector's display name ("MetaMask") rather than its client id ("metamask"). */
export function evmSigner(wallet: { address: string; walletClientType?: string | null; connectorType?: string | null; meta?: { name?: string | null } | null }, embedded: EmbeddedWallets): WalletSigner {
  if (isEmbeddedEvmWallet(wallet, embedded)) return { address: wallet.address, name: ANTARA_WALLET_NAME, embedded: true };
  return { address: wallet.address, name: wallet.meta?.name?.trim() || wallet.walletClientType?.trim() || FAMILY_FALLBACK.evm, embedded: false };
}

export interface WalletExplorerLink {
  /** "Solscan", "Etherscan", … */
  name: string;
  /** "Solana", "Ethereum", … */
  network: string;
  url: string;
}

/** Where to view the address: Solscan for Solana; each supported EVM network's explorer for an EVM address. */
export function walletExplorers(family: WalletFamily, address: string, solanaCluster: SolanaCluster = 'mainnet-beta'): WalletExplorerLink[] {
  const networks = family === 'solana' ? [SOLANA_NETWORK] : SUPPORTED_EVM_NETWORKS;
  return networks.map(network => ({ name: network.explorer.name, network: network.name, url: explorerAddressUrl(network, address, { solanaCluster }) }));
}

/** Readable messages for the export flow. Raw provider errors are never shown or logged. */
export const EXPORT_MESSAGES = Object.freeze({
  signedOut: 'Sign in to ANTARA to export your wallet.',
  external: 'Only your ANTARA wallet can be exported here. Export an external wallet from its own app.',
  unavailable: 'Wallet export isn’t available in this build.',
  disabled: 'Key export is turned off for ANTARA’s sign-in provider. Nothing was shown.',
  cancelled: 'Export cancelled. Your key was not shown.',
  notReady: 'Your ANTARA wallet is still loading. Try again in a moment.',
  session: 'Your session expired. Sign in again to export your wallet.',
  sessionChanged: 'Your session changed in another tab or window. Sign in again to export your wallet.',
  unsupported: 'This wallet can’t be exported.',
  verification: 'Verification didn’t complete, so the key was not shown. Try again.',
  failed: 'Couldn’t open the secure export window. Nothing was shown. Try again.',
});
const KNOWN = new Set<string>(Object.values(EXPORT_MESSAGES));

/** Maps whatever the export call threw to one of EXPORT_MESSAGES. */
export function exportErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (KNOWN.has(raw)) return raw;
  const text = raw.toLowerCase();
  if (/must be authenticated|not authenticated|access token|sign in/.test(text)) return EXPORT_MESSAGES.session;
  if (/must have an embedded wallet|no embedded wallet|not an embedded/.test(text)) return EXPORT_MESSAGES.external;
  if (/disabled|not enabled|not allowed|forbidden|\b403\b/.test(text)) return EXPORT_MESSAGES.disabled;
  if (/not supported/.test(text)) return EXPORT_MESSAGES.unsupported;
  if (/not ready|still loading/.test(text)) return EXPORT_MESSAGES.notReady;
  if (/\bmfa\b|verification|passkey|\botp\b/.test(text)) return EXPORT_MESSAGES.verification;
  if (/cancel|closed|exited|rejected|denied|abort/.test(text)) return EXPORT_MESSAGES.cancelled;
  return EXPORT_MESSAGES.failed;
}
