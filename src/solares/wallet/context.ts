import { createContext, useContext } from 'react';
import type { SolaresWalletState } from './types';
import { EXPORT_MESSAGES } from './walletIdentity';

const unavailable = async (): Promise<never> => { throw new Error('Set up sign-in and sign in to ANTARA to continue.'); };
/** Signed out (or no Privy in this build): there is no ANTARA wallet to export, so nothing opens. */
const exportUnavailable = async (): Promise<never> => { throw new Error(EXPORT_MESSAGES.signedOut); };
export const disconnectedWallet: SolaresWalletState = {
  configured: false, ready: true, authenticated: false, userId: null,
  addresses: { solana: null, ethereum: null }, login: () => {}, logout: async () => {},
  connectWallet: () => {}, enrollMfa: () => {}, getAccessToken: async () => null,
  getSession: () => ({ authenticated: false, userId: null, addresses: { solana: null, ethereum: null } }),
  balances: [], balancesLoading: false, balancesError: null, refetchBalances: async () => {},
  getEvmProvider: unavailable, signSolanaTransaction: unavailable, sendSolanaTransaction: unavailable,
  solanaSigners: [], selectSolanaSigner: () => {}, evmSigners: [], selectEvmSigner: () => {},
  exportWallet: exportUnavailable,
};
export const WalletContext = createContext<SolaresWalletState>(disconnectedWallet);
export function useSolaresWallet() { return useContext(WalletContext); }
