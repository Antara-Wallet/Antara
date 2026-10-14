import type { EIP1193Provider } from 'viem';
import type { NetworkKey } from '../networks';
import type { LinkedWallet } from './linkRecovery';

/** A supported network (registry key). Arbitrum and Polygon are no longer supported. */
export type WalletChain = NetworkKey;
export interface WalletSession {
  authenticated: boolean;
  userId: string | null;
  addresses: { solana: string | null; ethereum: string | null };
}
export interface WalletBalance {
  chain: WalletChain;
  symbol: string;
  address: string | null;
  decimals: number;
  raw: string;
  formatted: string;
  isNative: boolean;
}
/**
 * A wallet on the account. `embedded` marks the account's own Privy embedded wallet, shown
 * as the "ANTARA wallet" and the only kind ANTARA can open Privy's secure key export for.
 * Absent means external (Phantom, MetaMask, …): its keys live in that wallet's app.
 */
export interface WalletSigner {
  address: string;
  name: string;
  embedded?: boolean;
}
/** The chain family Privy's secure key export is opened for. */
export type ExportChain = 'solana' | 'ethereum';
export interface SolaresWalletState {
  configured: boolean;
  /** Visible reason sign-in is disabled by an invalid build configuration (for example a malformed public RPC URL). */
  configError?: string | null;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  addresses: { solana: string | null; ethereum: string | null };
  login: () => void;
  logout: () => Promise<void>;
  connectWallet: () => void;
  enrollMfa: () => void;
  /** The session token, checked against this tab's account: rejects with SessionChangedError (linkRecovery.ts) when it belongs to another. */
  getAccessToken: () => Promise<string | null>;
  getSession: () => WalletSession;
  /** This tab's token belongs to another account than the one shown (another tab or window signed in). */
  sessionChanged?: boolean;
  /** Signs the mismatched session out, then opens sign-in. */
  signInAgain?: () => void;
  /** The wallets Privy links to the signed-in account, as the API server checks them. Same identity while the set is unchanged. */
  linkedWallets?: readonly LinkedWallet[];
  balances: WalletBalance[];
  balancesLoading: boolean;
  balancesError: string | null;
  refetchBalances: () => Promise<void>;
  getEvmProvider: (chainId: number) => Promise<EIP1193Provider>;
  signSolanaTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  /**
   * The wallet signs; ANTARA broadcasts once and resolves with the signature without waiting for
   * confirmation (callers poll: solanaConfirm.ts). Rejects with SolanaSendError (solanaSend.ts) when
   * it may have been broadcast ('unknown', with the signature to follow) or the RPC refused it (false);
   * any other rejection sent nothing.
   */
  sendSolanaTransaction: (transaction: Uint8Array) => Promise<string>;
  solanaSigners: WalletSigner[];
  selectSolanaSigner: (address: string) => void;
  evmSigners: WalletSigner[];
  selectEvmSigner: (address: string) => void;
  /**
   * Opens Privy's secure export window for one of this account's ANTARA (embedded) wallets.
   * The key is shown only inside Privy's iframe on Privy's origin: ANTARA never receives,
   * logs, stores or copies it. Resolves when that window closes; rejects with a readable
   * message when export is unavailable (signed out, external wallet, turned off, cancelled).
   */
  exportWallet: (chain: ExportChain, address: string) => Promise<void>;
}
