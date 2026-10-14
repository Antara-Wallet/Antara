// Area E parity preview (docs/UI_ARGUS_PARITY.md 9, 10). Browser-only: never imported by
// the application or the production build.
//
// Until the integration pass points shell/screens.ts at activity/ActivityScreen and
// settings/SettingsScreen, the real shell still renders the legacy panels. This page
// renders Area E's screens in the shell's own frame (Area A's Sidebar, Topbar, account
// pill and bottom tabs, with the shell's CSS) around a fixture WalletContext that is the
// same as harness.tsx's. Nothing here signs or reaches Privy. The frame is marked
// data-parity-ignore, so the truth checks read Area E's screens only (Area A runs its own
// shell scenarios).
//
//   #activity | #settings | #addressbook   which screen (Settings › Address book for the last)
//   state, failed, balances, surface, webgl  as in harness.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { EIP1193Provider } from 'viem';
import '../../src/index.css';
import '../../src/extension/extension.css';
// The shell's stylesheets, in DesktopWallet.tsx's order.
import '../../src/solares/desktop.css';
import '../../src/solares/cinematic.css';
import '../../src/solares/observatory.css';
import '../../src/solares/wallet-ui.css';
import '../../src/solares/mobile.css';
import '../../src/solares/shell/shell.css';
import { WalletContext, disconnectedWallet, useSolaresWallet } from '../../src/solares/wallet/context';
import { canonicalBalance } from '../../src/solares/wallet/balances';
import { byKey, isNetworkKey } from '../../src/solares/networks';
import type { SolaresWalletState, WalletBalance } from '../../src/solares/wallet/types';
import { CelestialScene } from '../../src/solares/CelestialScene';
import { ToastProvider, useToast } from '../../src/solares/ui';
import { PairedVaultSummaryProvider } from '../../src/solares/shell/screens';
import { Sidebar, desktopLabel } from '../../src/solares/shell/Sidebar';
import { Topbar } from '../../src/solares/shell/Topbar';
import { BottomTabs, narrowLabel } from '../../src/solares/shell/BottomTabs';
import { AccountPill } from '../../src/solares/shell/AccountPill';
import { pillModel } from '../../src/solares/shell/accountModel';
import type { Page } from '../../src/solares/shell/routes';
import { ActivityScreen } from '../../src/solares/activity/ActivityScreen';
import { SettingsScreen } from '../../src/solares/settings/SettingsScreen';
import { PARITY_EVM_WALLETS, PARITY_KEYS, PARITY_USER_ID } from './keys';

declare global {
  interface Window {
    /** Calls the fixture and the frame received (login, navigate:#vault, openAccounts, …), for scenario steps to inspect. */
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

const NARROW_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';
const signingDisabled = async (): Promise<never> => { throw new Error('Fixture: signing disabled'); };

/** Same fixture balances as harness.tsx: every network, registry order, exact decimals. */
function fixtureBalances(): WalletBalance[] {
  if (balanceMode === 'loading') return [];
  const zero = balanceMode === 'empty';
  const amount = (value: bigint) => (zero ? 0n : value);
  return [
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
  ].filter(balance => balance.chain !== failed && (state !== 'evm-only' || balance.chain !== 'solana'));
}

function fixtureEvmProvider(chainId: number, address: string): EIP1193Provider {
  const request = async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
    throw new Error(/sign|send/i.test(method) ? 'Fixture: signing disabled' : `Fixture: ${method} is not available`);
  };
  return { request, on: () => undefined, removeListener: () => undefined } as unknown as EIP1193Provider;
}

function FixtureWallet({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(state === 'signed-in' || state === 'evm-only');
  const [evmAddress, setEvmAddress] = useState(PARITY_EVM_WALLETS[0].address);
  const solana = state === 'evm-only' ? null : PARITY_KEYS.user;
  const addresses = authenticated ? { solana, ethereum: evmAddress } : { solana: null, ethereum: null };
  const session = useRef({ authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses });
  session.current = { authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses };
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
    balances: authenticated ? fixtureBalances() : [],
    balancesLoading: authenticated && balanceMode === 'loading',
    balancesError: authenticated && failed && isNetworkKey(failed) ? `Live balances unavailable on ${byKey(failed).name}. Check your RPC connections.` : null,
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
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

type Screen = 'activity' | 'settings' | 'addressbook';
const screenFor = (hash: string): Screen => {
  const key = hash.replace(/^#/, '').toLowerCase();
  return key === 'activity' || key === 'addressbook' ? key : 'settings';
};
const readPreference = (key: string, fallback: boolean) => {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === 'true'; } catch { return fallback; }
};

/** Harness-only chrome: the truth checks skip it (data-parity-ignore); layout is unchanged (display: contents). */
function Chrome({ children }: { children: ReactNode }) {
  return <div data-parity-ignore="" style={{ display: 'contents' }}>{children}</div>;
}

function Frame() {
  const wallet = useSolaresWallet();
  const toast = useToast();
  const [screen, setScreen] = useState<Screen>(() => screenFor(location.hash));
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW_QUERY).matches);
  const [navExpanded, setNavExpanded] = useState(() => !matchMedia(NARROW_QUERY).matches && readPreference('solares.desktop.nav', true));
  const [privacy, setPrivacy] = useState(() => readPreference('solares-balance-privacy', false));
  const [motion, setMotion] = useState(() => readPreference('aethra.motion', true));
  useEffect(() => {
    const media = matchMedia(NARROW_QUERY);
    const update = () => setNarrow(media.matches);
    const onHash = () => setScreen(screenFor(location.hash));
    media.addEventListener('change', update);
    addEventListener('hashchange', onHash);
    return () => { media.removeEventListener('change', update); removeEventListener('hashchange', onHash); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? 'on' : 'off';
  }, [motion]);
  // The shell's preference keys, as DesktopWallet persists them.
  useEffect(() => {
    try {
      if (!narrow) localStorage.setItem('solares.desktop.nav', String(navExpanded));
      localStorage.setItem('solares-balance-privacy', String(privacy));
      localStorage.setItem('aethra.motion', String(motion));
    } catch { /* storage blocked: preferences last for this page */ }
  }, [narrow, navExpanded, privacy, motion]);
  const page: Page = screen === 'activity' ? 'Activity' : 'Settings';
  const signIn = () => {
    if (!wallet.configured) {
      location.hash = 'settings';
      toast.show(wallet.configError || 'Sign-in is being set up. Please try again later.');
    } else wallet.login();
  };
  const go = (next: Page) => {
    record(`navigate:${next}`);
    if (next === 'Activity' || next === 'Settings') location.hash = next.toLowerCase();
  };
  const solanaView = !!wallet.addresses.solana || !wallet.addresses.ethereum;
  const address = wallet.authenticated ? (solanaView ? wallet.addresses.solana : wallet.addresses.ethereum) : null;
  const pill = pillModel({
    authenticated: wallet.authenticated,
    configured: wallet.configured,
    address,
    name: (solanaView ? wallet.solanaSigners : wallet.evmSigners).find(item => item.address === address)?.name ?? null,
    solanaView,
  });
  return (
    <div className={`desktop-app shell-app ${navExpanded ? 'desktop-nav-expanded' : ''}`} data-motion={motion ? 'on' : 'off'} data-window-hidden="false" data-narrow={narrow || undefined}>
      <CelestialScene active={motion} />
      {!narrow && (
        <Chrome>
          <Sidebar page={page} expanded={navExpanded} inert={false} authenticated={wallet.authenticated} onNavigate={go} onSignIn={signIn} onSignOut={() => void wallet.logout()} />
        </Chrome>
      )}
      <div className="desktop-main shell-main">
        <Chrome>
          <Topbar
            title={narrow ? narrowLabel(page) : desktopLabel(page)}
            narrow={narrow}
            navExpanded={navExpanded}
            onToggleNav={() => setNavExpanded(!navExpanded)}
            onSettingsGear={() => go(page === 'Settings' ? 'Portfolio' : 'Settings')}
            onSettingsPage={page === 'Settings'}
            pill={<AccountPill model={pill} authenticated={wallet.authenticated} vaultSide={false} onOpen={() => record('openAccounts')} />}
          />
        </Chrome>
        <div className="desktop-body">
          <main key={page} className="desktop-content shell-content desktop-secondary-content">
            {screen === 'activity' ? (
              <ActivityScreen privacy={privacy} onConnect={signIn} onSwap={() => go('Swap')} />
            ) : (
              <SettingsScreen
                section={screen === 'addressbook' ? 'address-book' : undefined}
                isMobile={narrow}
                privacy={privacy}
                onPrivacy={setPrivacy}
                motion={motion}
                onMotion={setMotion}
                navExpanded={navExpanded}
                onNavExpanded={setNavExpanded}
                onNavigate={hash => record(`navigate:${hash}`)}
                onSignIn={signIn}
                onOpenAccounts={() => record('openAccounts')}
              />
            )}
          </main>
        </div>
        {narrow && <Chrome><BottomTabs page={page} onNavigate={go} /></Chrome>}
      </div>
    </div>
  );
}

/** Static copy of src/extension/sidepanel.tsx's bar, as in harness.tsx. */
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

createRoot(document.getElementById('root')!).render(
  <FixtureWallet>
    {sidePanel && <SidePanelBarReplica />}
    <ToastProvider>
      <PairedVaultSummaryProvider>
        <Frame />
      </PairedVaultSummaryProvider>
    </ToastProvider>
  </FixtureWallet>,
);
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
