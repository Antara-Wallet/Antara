// Area B parity page (docs/UI_ARGUS_PARITY.md 6.7-6.9, 10.2). Browser-only: never
// imported by the application or the production build. Mounts ReceiveSheet, SendFlow
// and AddressBookScreen directly, inside the same kind of fixture WalletContext as
// harness.tsx, because the shell keeps today's dialogs until the integration pass
// switches shell/screens.ts. Nothing here signs: every signing function throws.
//
// Query parameters (plus harness.tsx's state, failed, balances and surface):
//   screen=receive | receive-vault | send | addressbook
//   chain=<network key>         initial network (default solana)
//   asset=native | stablecoin   initial asset (Token detail entry)
//   vault=active | passkey-needed | loading | not-provisioned   vault summary fixture (8.2)
// The page sets <html data-parity-ready="1"> once rendered and fonts are loaded.
import { StrictMode, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Keypair } from '@solana/web3.js';
import type { EIP1193Provider } from 'viem';
import { WalletContext, disconnectedWallet } from '../../src/solares/wallet/context';
import { canonicalBalance } from '../../src/solares/wallet/balances';
import { byKey, isNetworkKey, type NetworkKey } from '../../src/solares/networks';
import type { SolaresWalletState, WalletBalance } from '../../src/solares/wallet/types';
import { Icon, ToastProvider } from '../../src/solares/ui';
import { ReceiveSheet } from '../../src/solares/receive/ReceiveSheet';
import { SendFlow } from '../../src/solares/transfers/SendFlow';
import { AddressBookScreen } from '../../src/solares/addressbook/AddressBookScreen';
import type { VaultSummaryInput } from '../../src/solares/receive/vaultTarget';
import { layerGate, type VaultLayersLoad } from '../../src/solares/layers/gate';
import { parseVaultLayers } from '../../src/solares/layers/schema';
import { FIXTURE_MULTISIG, emptyLayersFixture, layersFixture } from '../../src/solares/layers/testFixtures';
import { PARITY_EVM_WALLETS, PARITY_KEYS, PARITY_USER_ID } from './keys';
import '../../src/index.css';
// Every rule in extension.css is scoped to html[data-surface=...], so it is inert unless the panel surface is set.
import '../../src/extension/extension.css';

declare global {
  interface Window { __parityCalls: string[] }
}
window.__parityCalls = [];
const record = (call: string) => { window.__parityCalls.push(call); };

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'signed-in';
const failed = params.get('failed');
const balanceMode = params.get('balances');
const sidePanel = params.get('surface') === 'sidepanel';
const screen = params.get('screen') ?? 'receive';
const initialChain: NetworkKey = isNetworkKey(params.get('chain')) ? params.get('chain') as NetworkKey : 'solana';
const initialAsset = params.get('asset') === 'native' || params.get('asset') === 'stablecoin' ? params.get('asset') as 'native' | 'stablecoin' : undefined;
if (sidePanel) document.documentElement.dataset.surface = 'sidepanel';

/** A fixed, never-funded deposit address for the fixture vault: Keypair.fromSeed(fill(9)). */
const VAULT_DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
function vaultFixture(): VaultSummaryInput | null {
  const profile = params.get('vault');
  const ready = (fixture: unknown): VaultLayersLoad => ({ status: 'ready', view: parseVaultLayers(fixture, FIXTURE_MULTISIG), refreshing: false });
  if (profile === 'active') {
    const layers = ready(layersFixture());
    return { state: 'active', multisig: FIXTURE_MULTISIG, depositAddress: VAULT_DEPOSIT, gate: layerGate(layers), layers, releaseBlock: '' };
  }
  if (profile === 'passkey-needed') return { state: 'registered', stage: 'activate-passkey', multisig: FIXTURE_MULTISIG, depositAddress: VAULT_DEPOSIT, layers: ready(emptyLayersFixture()) };
  if (profile === 'loading') return { state: 'loading' };
  if (profile === 'not-provisioned') return { state: 'not-provisioned' };
  return null;
}

const signingDisabled = async (): Promise<never> => { throw new Error('Fixture: signing disabled'); };

/** Same fixture balances as harness.tsx: every network in registry order, exact registry decimals. */
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

function Page() {
  const [open, setOpen] = useState<string | null>(screen === 'addressbook' ? null : screen);
  const receiveLauncher = useRef<HTMLButtonElement>(null);
  const sendLauncher = useRef<HTMLButtonElement>(null);
  const vault = useMemo(vaultFixture, []);
  return (
    <main className="ui-scope srp-page" data-parity-scroll="">
      <header className="srp-header">
        <img src="/antara/app-icon-192.png" width="28" height="28" alt="" />
        <span>ANTARA</span>
        <nav className="srp-launch" aria-label="Open a screen">
          <button ref={receiveLauncher} type="button" className="ui-btn" onClick={() => setOpen('receive')}><Icon name="down" size={16} /> Receive</button>
          <button ref={sendLauncher} type="button" className="ui-btn" onClick={() => setOpen('send')}><Icon name="up" size={16} /> Send</button>
        </nav>
      </header>
      {screen === 'addressbook' && <div className="srp-settings"><AddressBookScreen vaultSummary={vault} onBack={sidePanel || innerWidth <= 640 ? () => record('back') : undefined} /></div>}
      {(open === 'receive' || open === 'receive-vault') && (
        <ReceiveSheet
          initialChain={initialChain}
          initialAsset={initialAsset}
          side={open === 'receive-vault' ? 'vault' : 'wallet'}
          vaultSummary={vault}
          onClose={() => setOpen(null)}
          onSignIn={() => record('signIn')}
          returnFocusTo={receiveLauncher.current}
        />
      )}
      {open === 'send' && (
        <SendFlow
          initialChain={initialChain}
          initialAsset={initialAsset}
          vaultSummary={vault}
          onClose={() => setOpen(null)}
          onOpenVaultDeposit={() => { record('openVaultDeposit'); setOpen(null); }}
          onReceive={chain => { record(`receive:${chain}`); setOpen('receive'); }}
          returnFocusTo={sendLauncher.current}
        />
      )}
    </main>
  );
}

function Harness() {
  const [authenticated, setAuthenticated] = useState(state === 'signed-in' || state === 'evm-only');
  const evmAddress = PARITY_EVM_WALLETS[0].address;
  const solana = state === 'evm-only' ? null : PARITY_KEYS.user;
  const addresses = authenticated ? { solana, ethereum: evmAddress } : { solana: null, ethereum: null };
  const session = useRef({ authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses });
  session.current = { authenticated, userId: authenticated ? PARITY_USER_ID : null, addresses };
  const balances = authenticated ? fixtureBalances() : [];
  const value: SolaresWalletState = state === 'unconfigured' ? { ...disconnectedWallet, login: () => record('login') } : {
    ...disconnectedWallet,
    configured: true, ready: true, authenticated,
    userId: authenticated ? PARITY_USER_ID : null,
    addresses,
    login: () => record('login'),
    logout: async () => { record('logout'); setAuthenticated(false); },
    getAccessToken: async () => (authenticated ? 'parity-token' : null),
    getSession: () => session.current,
    balances,
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
    selectEvmSigner: address => record(`selectEvmSigner:${address}`),
  };
  return (
    <WalletContext.Provider value={value}>
      {sidePanel && (
        <div className="extension-panel-bar" data-parity-ignore="">
          <span className="extension-panel-bar-label">Side panel</span>
          <button type="button" className="extension-panel-bar-button" onClick={() => record('openFullTab')}>Open in full tab <span aria-hidden="true">↗</span></button>
        </div>
      )}
      <Page />
    </WalletContext.Provider>
  );
}

// Harness-only layout: a plain charcoal page behind the sheets, like the wallet's own background.
const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; background: #08090b; }
  .srp-page { box-sizing: border-box; min-height: calc(var(--wallet-viewport-height, 100dvh) - var(--extension-bar-height, 0px)); padding: 16px; background: var(--ink-1); color: var(--fg); font: 400 13px/1.5 var(--font-ui); }
  .srp-header { display: flex; align-items: center; gap: 10px; max-width: 1120px; margin: 0 auto 20px; font: 600 15px/1 var(--font-display); letter-spacing: .08em; }
  .srp-header img { border-radius: 8px; }
  .srp-launch { display: flex; gap: 8px; margin-left: auto; }
  .srp-settings { max-width: 760px; margin: 0 auto; }
  @media (max-width: 640px) { .srp-launch .ui-btn { padding: 0 12px; } }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<StrictMode><ToastProvider><Harness /></ToastProvider></StrictMode>);
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
