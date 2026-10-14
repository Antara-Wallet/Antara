import { lazy, Suspense, type ReactNode } from 'react';
import { PRIVY_APP_ID } from './config';
import { WalletContext, disconnectedWallet } from './context';

const LiveWalletProvider = lazy(() => import('./LiveWalletProvider'));
export { useSolaresWallet } from './context';
export type { ExportChain, SolaresWalletState, WalletBalance, WalletChain, WalletSession, WalletSigner } from './types';

/** Preview never initializes Privy, requests credentials, or creates synthetic wallets. */
export function SolaresWalletProvider({ children }: { children: ReactNode }) {
  const fallback = <WalletContext.Provider value={{ ...disconnectedWallet, configured: !!PRIVY_APP_ID, ready: !PRIVY_APP_ID }}>{children}</WalletContext.Provider>;
  return PRIVY_APP_ID
    ? <Suspense fallback={fallback}><LiveWalletProvider>{children}</LiveWalletProvider></Suspense>
    : fallback;
}
