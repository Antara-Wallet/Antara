// Parity screenshot harness (docs/UI_ARGUS_PARITY.md 10.2). Browser-only: never
// imported by the application or the production build. Renders the real wallet shell
// (DesktopWallet) inside a fixture WalletContext; nothing here signs or reaches Privy.
//
// Query parameters:
//   state=signed-out | unconfigured | signed-in (default) | evm-only
//   failed=<network key>      omit that network's balances and report it, as the live provider does
//   balances=loading | empty  balances still loading, or every balance a known zero
//   surface=sidepanel         render as the Chrome side panel (data-surface, extension.css, 30px bar replica)
//   webgl=0                   WebGL contexts return null, forcing the still fallback
// The page sets <html data-parity-ready="1"> once rendered and fonts are loaded.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EIP1193Provider } from 'viem';
import DesktopWallet from '../../src/solares/DesktopWallet';
import { WalletContext, disconnectedWallet } from '../../src/solares/wallet/context';
import { canonicalBalance } from '../../src/solares/wallet/balances';
import { byKey, isNetworkKey } from '../../src/solares/networks';
import type { SolaresWalletState, WalletBalance } from '../../src/solares/wallet/types';
import { PARITY_EVM_WALLETS, PARITY_KEYS, PARITY_USER_ID } from './keys';
import '../../src/index.css';
// Every rule in extension.css is scoped to html[data-surface=...], so it is inert unless the panel surface is set.
import '../../src/extension/extension.css';

declare global {
  interface Window {
    /** Calls the fixture received (login, connectWallet, select...), for scenario steps to inspect. */
    __parityCalls: string[];
  }
}
window.__parityCalls = [];
const record = (call: string) => { window.__parityCalls.push(call); };

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'signed-in';
const failed = params.get('failed');
const balanceMode = params.get('balances');
const sidePanel = params.get('surface') === 'sidepanel';

if (sidePanel) document.documentElement.dataset.surface = 'sidepanel';
if (params.get('webgl') === '0') {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
    return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

const signingDisabled = async (): Promise<never> => { throw new Error('Fixture: signing disabled'); };

/** Fixture balances for every network, in registry order, from the registry's own assets (exact decimals). */
function fixtureBalances(): WalletBalance[] {
  if (balanceMode === 'loading') return [];
  const zero = balanceMode === 'empty';
  const amount = (value: bigint) => (zero ? 0n : value);
  const all = [
    canonicalBalance('solana', amount(1_250_000_000n), true),
    canonicalBalance('solana', amount(42_500_000n), false),
    canonicalBalance('ethereum', amount(50_000_000_000_000_000n), true),
    canonicalBalance('ethereum', amount(25_000_000n), false),
    canonicalBalance('bsc', amount(250_000_000_000_000_000n), true),
    canonicalBalance('bsc', amount(1_500_000_000_000_000_000n), false),
    canonicalBalance('robinhood', amount(10_000_000_000_000_000n), true),
    canonicalBalance('robinhood', amount(2_500_000n), false),
    canonicalBalance('base', 0n, true),
    canonicalBalance('base', amount(10_000_000n), false),
  ];
  return all.filter(balance => balance.chain !== failed && (state !== 'evm-only' || balance.chain !== 'solana'));
}

/** A read-only EIP-1193 provider: answers chain and account reads, refuses anything that signs or sends. */
function fixtureEvmProvider(chainId: number, address: string): EIP1193Provider {
  const request = async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
    throw new Error(/sign|send/i.test(method) ? 'Fixture: signing disabled' : `Fixture: ${method} is not available`);
  };
  return { request, on: () => undefined, removeListener: () => undefined } as unknown as EIP1193Provider;
}

function Harness() {
  const [authenticated, setAuthenticated] = useState(state === 'signed-in' || state === 'evm-only');
  const [evmAddress, setEvmAddress] = useState(PARITY_EVM_WALLETS[0].address);
  const solana = state === 'evm-only' ? null : PARITY_KEYS.user;
  const addresses = authenticated ? { solana, ethereum: evmAddress } : { solana: null, ethereum: null };
  const session = useRef({ authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses });
  session.current = { authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses };
  const balances = authenticated ? fixtureBalances() : [];
  const balancesError = authenticated && failed && isNetworkKey(failed) ? `Live balances unavailable on ${byKey(failed).name}. Check your RPC connections.` : null;
  const value: SolaresWalletState = state === 'unconfigured' ? { ...disconnectedWallet, login: () => record('login') } : {
    ...disconnectedWallet,
    configured: true, ready: true, authenticated,
    userId: authenticated ? PARITY_USER_ID : null,
    addresses,
    login: () => record('login'),
    logout: async () => { record('logout'); setAuthenticated(false); },
    connectWallet: () => record('connectWallet'),
    enrollMfa: () => record('enrollMfa'),
    getAccessToken: async () => (authenticated ? 'parity-token' : null),
    getSession: () => session.current,
    balances,
    balancesLoading: authenticated && balanceMode === 'loading',
    balancesError,
    refetchBalances: async () => { record('refetchBalances'); },
    getEvmProvider: async chainId => {
      if (!authenticated) throw new Error('Fixture: signed out');
      return fixtureEvmProvider(chainId, evmAddress);
    },
    signSolanaTransaction: signingDisabled,
    sendSolanaTransaction: signingDisabled,
    solanaSigners: authenticated && solana ? [{ address: solana, name: 'Solana wallet' }] : [],
    selectSolanaSigner: address => record(`selectSolanaSigner:${address}`),
    evmSigners: authenticated ? PARITY_EVM_WALLETS.map(item => ({ ...item })) : [],
    selectEvmSigner: address => { record(`selectEvmSigner:${address}`); setEvmAddress(address); },
  };
  return (
    <WalletContext.Provider value={value}>
      {sidePanel && <SidePanelBarReplica />}
      <DesktopWallet />
    </WalletContext.Provider>
  );
}

/** Static copy of src/extension/sidepanel.tsx's bar (that file mounts its own root, so it is not imported). */
function SidePanelBarReplica() {
  return (
    <div className="extension-panel-bar" data-parity-ignore="">
      <span className="extension-panel-bar-label">Side panel</span>
      <button type="button" className="extension-panel-bar-button" onClick={() => record('openFullTab')}>
        Open in full tab <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
// Ready once React has committed and every font face in use has loaded.
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
