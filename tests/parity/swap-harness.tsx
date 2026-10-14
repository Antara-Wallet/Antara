// Area C parity page (docs/UI_ARGUS_PARITY.md 6.10, 10.2): the real wallet shell
// (DesktopWallet) signed in as the placeholder wallets of the Relay orders captured
// read-only on 2026-10-12 (server/src/solares/fixtures/relay-orders, README.md).
//
// Why a second page: a Relay quote is only shown after `verifyReviewedQuote` checks the
// order hash and Relay's pinned solver signature, and the signed order commits to the
// capture's own wallets. The shared harness (harness.tsx) signs in as the fixture keys,
// so no captured quote can verify there, and an invented quote must never verify. Here
// the review renders the real `describeSettlement()` disclosure of a real signed order.
//
// Nothing signs: every signing function throws "Fixture: signing disabled". The placeholder
// wallets hold no funds and no one holds their keys (README "Placeholder addresses").
//
// Query parameters: surface=sidepanel (as harness.tsx). Sets <html data-parity-ready="1">.
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopWallet from '../../src/solares/DesktopWallet';
import { WalletContext, disconnectedWallet } from '../../src/solares/wallet/context';
import { canonicalBalance } from '../../src/solares/wallet/balances';
import type { SolaresWalletState, WalletBalance } from '../../src/solares/wallet/types';
import manifest from '../../server/src/solares/fixtures/relay-orders/manifest.json';
import { PARITY_USER_ID } from './keys';
import '../../src/index.css';
import '../../src/extension/extension.css';

const params = new URLSearchParams(location.search);
const sidePanel = params.get('surface') === 'sidepanel';
if (sidePanel) document.documentElement.dataset.surface = 'sidepanel';

const SOLANA = manifest.placeholders.solana;
const EVM = manifest.placeholders.evm;
const signingDisabled = async (): Promise<never> => { throw new Error('Fixture: signing disabled'); };

/** The same fixture amounts as harness.tsx, from the registry's own assets (exact decimals). */
const BALANCES: WalletBalance[] = [
  canonicalBalance('solana', 1_250_000_000n, true),
  canonicalBalance('solana', 42_500_000n, false),
  canonicalBalance('ethereum', 50_000_000_000_000_000n, true),
  canonicalBalance('ethereum', 25_000_000n, false),
  canonicalBalance('bsc', 250_000_000_000_000_000n, true),
  canonicalBalance('bsc', 1_500_000_000_000_000_000n, false),
  canonicalBalance('robinhood', 10_000_000_000_000_000n, true),
  canonicalBalance('robinhood', 2_500_000n, false),
  canonicalBalance('base', 0n, true),
  canonicalBalance('base', 10_000_000n, false),
];

function Harness() {
  const addresses = { solana: SOLANA, ethereum: EVM };
  const session = useRef({ authenticated: true, userId: PARITY_USER_ID, addresses });
  const value: SolaresWalletState = {
    ...disconnectedWallet,
    configured: true, ready: true, authenticated: true,
    userId: PARITY_USER_ID,
    addresses,
    login: () => undefined,
    logout: async () => undefined,
    connectWallet: () => undefined,
    enrollMfa: () => undefined,
    getAccessToken: async () => 'parity-token',
    getSession: () => session.current,
    balances: BALANCES,
    balancesLoading: false,
    balancesError: null,
    refetchBalances: async () => undefined,
    getEvmProvider: async () => { throw new Error('Fixture: signing disabled'); },
    signSolanaTransaction: signingDisabled,
    sendSolanaTransaction: signingDisabled,
    solanaSigners: [{ address: SOLANA, name: 'Solana wallet' }],
    selectSolanaSigner: () => undefined,
    evmSigners: [{ address: EVM, name: 'Wallet one' }],
    selectEvmSigner: () => undefined,
  };
  return (
    <WalletContext.Provider value={value}>
      {sidePanel && (
        <div className="extension-panel-bar" data-parity-ignore="">
          <span className="extension-panel-bar-label">Side panel</span>
          <button type="button" className="extension-panel-bar-button">Open in full tab <span aria-hidden="true">↗</span></button>
        </div>
      )}
      <DesktopWallet />
    </WalletContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
