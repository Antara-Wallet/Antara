// Privy's secure key export behind `wallet.exportWallet` (LiveWalletProvider only, inside
// PrivyProvider). Privy shows the key in its own iframe on its own origin (auth.privy.io,
// already the only frame-src the web, desktop and extension CSPs allow); the hooks resolve
// with nothing when that window closes. ANTARA never receives, logs, stores or copies the
// key, and failures are reported only as EXPORT_MESSAGES text, never the raw error.
import { useExportWallet as useExportEthereumWallet } from '@privy-io/react-auth';
import { useExportWallet as useExportSolanaWallet } from '@privy-io/react-auth/solana';
import type { ExportChain } from './types';
import { SessionChangedError } from './linkRecovery';
import { EXPORT_MESSAGES, exportErrorMessage, isEmbeddedAddress, type EmbeddedWallets } from './walletIdentity';

export interface WalletExportOptions {
  authenticated: boolean;
  /** This tab's token belongs to another account than the one it shows (LiveWalletProvider). */
  sessionChanged: boolean;
  /** The session token, checked against this tab's account: rejects with SessionChangedError on a mismatch. */
  getSessionToken: () => Promise<string | null>;
  /** The account's embedded wallets, from Privy's linked accounts only (walletIdentity.embeddedWalletsOf). */
  embedded: EmbeddedWallets;
}

export function useWalletExport({ authenticated, sessionChanged, getSessionToken, embedded }: WalletExportOptions) {
  const { exportWallet: exportEthereum } = useExportEthereumWallet();
  const { exportWallet: exportSolana } = useExportSolanaWallet();
  return async (chain: ExportChain, address: string): Promise<void> => {
    if (!authenticated) throw new Error(EXPORT_MESSAGES.signedOut);
    if (sessionChanged) throw new Error(EXPORT_MESSAGES.sessionChanged);
    // Only this account's own embedded wallet, as Privy's linked accounts list it: an external
    // wallet's keys live in its app, and what a connected wallet says about itself is not trusted.
    if (!isEmbeddedAddress(embedded, chain, address)) throw new Error(EXPORT_MESSAGES.external);
    // Privy's export finds the wallet on this tab's user but sends the origin's shared token (which
    // another tab or window may have replaced) into its iframe: that token must be this account's.
    let token: string | null;
    try { token = await getSessionToken(); }
    catch (error) { throw new Error(error instanceof SessionChangedError ? EXPORT_MESSAGES.sessionChanged : EXPORT_MESSAGES.session); }
    if (!token) throw new Error(EXPORT_MESSAGES.session);
    try {
      if (chain === 'solana') await exportSolana({ address });
      else await exportEthereum({ address });
    } catch (error) {
      throw new Error(exportErrorMessage(error));
    }
  };
}
