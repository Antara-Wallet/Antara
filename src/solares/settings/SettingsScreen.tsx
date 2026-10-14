// Settings (docs/UI_ARGUS_PARITY.md 6.16): ARGUS S20's section order adapted to ANTARA:
// Account · Wallets · Address book · Security · Preferences · Networks · About.
// Omitted, with no "coming soon": Language, Currency, Change password, Reset wallet, Dev
// Tools (section 3). Owner decision 2026-10-13: each wallet row has a settings cog
// (shell/WalletSettings.tsx) whose ANTARA wallet sheet opens Privy's secure key export;
// ANTARA itself never reveals, receives or stores a key.
//
// Kept for the browser specs until the post-gate test update: the switches "Celestial
// motion", "Hide balances", "Show navigation labels", the button "Manage existing" and the
// embedded region "Multisig vault workspace". There is no "Settings" heading here: the
// shell's page title is the only one.
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react';
import { useSolaresWallet, type WalletSigner } from '../wallet';
import { walletIdentity } from '../wallet/walletIdentity';
import { SUPPORTED_EVM_NETWORKS } from '../networks';
import { usePairedVaultSummary } from '../shell/screens';
import { hostedVaultStatus, vaultRowStatus } from '../shell/accountModel';
import { WalletSettingsButton } from '../shell/WalletSettings';
import { TokenLogo } from '../TokenLogo';
import { AddressText, Icon, StatusChip, useToast } from '../ui';
import { SettingsRow, SettingsSection, SettingsSwitch } from './SettingsParts';
import { NetworksPanel } from './NetworksPanel';
import { AboutPanel } from './AboutPanel';
import './settings.css';

const VaultWorkspace = lazy(() => import('../vaults/VaultWorkspace').then(module => ({ default: module.VaultWorkspace })));

/**
 * Area B's AddressBookScreen (6.9), when it is in this build. The glob resolves to nothing
 * until src/solares/addressbook/AddressBookScreen.tsx exists, so Settings compiles before
 * and after Area B lands; the integration pass may replace this with a static import.
 */
const addressBookModules = import.meta.glob<{ AddressBookScreen?: ComponentType<{ onBack?: () => void }> }>('../addressbook/AddressBookScreen.tsx');
const loadAddressBook = Object.values(addressBookModules)[0];
const AddressBookScreen = loadAddressBook
  ? lazy(async () => {
    const module = await loadAddressBook();
    if (!module.AddressBookScreen) throw new Error('AddressBookScreen is missing from addressbook/AddressBookScreen.tsx.');
    return { default: module.AddressBookScreen };
  })
  : null;

const EVM_FAMILY = `EVM · ${SUPPORTED_EVM_NETWORKS.map(network => network.name).join(', ')}`;

export interface SettingsScreenProps {
  /** `#addressbook`: open the Address book (a sub-page on narrow screens). */
  section?: 'address-book';
  isMobile: boolean;
  privacy: boolean;
  onPrivacy: (next: boolean) => void;
  motion: boolean;
  onMotion: (next: boolean) => void;
  navExpanded: boolean;
  onNavExpanded: (next: boolean) => void;
  /** Shell navigation by hash, with its '#': '#vault', '#vaultlayers', '#protection'. */
  onNavigate: (hash: string) => void;
  onSignIn: () => void;
  onOpenAccounts: () => void;
}

export function SettingsScreen({
  section, isMobile, privacy, onPrivacy, motion, onMotion, navExpanded, onNavExpanded, onNavigate, onSignIn, onOpenAccounts,
}: SettingsScreenProps) {
  const wallet = useSolaresWallet();
  const toast = useToast();
  const summary = usePairedVaultSummary();
  const [existingVaults, setExistingVaults] = useState(false);
  const [addressBookPage, setAddressBookPage] = useState(section === 'address-book' && isMobile);
  const addressBookSection = useRef<HTMLElement>(null);
  const addressBookOpener = useRef<HTMLButtonElement>(null);
  const returnToOpener = useRef(false);
  const signedOut = !wallet.authenticated;

  // #addressbook: the sub-page on narrow screens; on desktop, the inline section in view.
  useEffect(() => {
    if (section !== 'address-book') return;
    if (isMobile) { setAddressBookPage(true); return; }
    const target = addressBookSection.current;
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [section, isMobile]);
  // The sub-page exists only on narrow screens.
  useEffect(() => { if (!isMobile) setAddressBookPage(false); }, [isMobile]);
  // Back from the sub-page returns focus to "Open".
  useEffect(() => {
    if (addressBookPage || !returnToOpener.current) return;
    returnToOpener.current = false;
    addressBookOpener.current?.focus();
  }, [addressBookPage]);

  async function signOut() {
    try {
      await wallet.logout();
    } catch {
      toast.show('Unable to sign out. Please try again.');
    }
  }

  if (addressBookPage) {
    return (
      <div className="set-screen set-subpage">
        <section className="set-addressbook-page" aria-label="Address book">
          <AddressBookBody onBack={() => { returnToOpener.current = true; setAddressBookPage(false); }} />
        </section>
      </div>
    );
  }

  // With the ANTARA Solana wallet selected, the same status as the drawer's Vault row: never
  // "Use your ANTARA wallet" for the wallet that is one.
  const antaraSelected = wallet.solanaSigners.some(signer => signer.embedded && signer.address === wallet.addresses.solana);
  const vaultStatus = signedOut ? null : antaraSelected ? hostedVaultStatus(summary, true) : vaultRowStatus(summary);
  const accountText = wallet.configured
    ? wallet.authenticated ? 'You’re signed in.' : 'Sign in to create or access your wallet.'
    : wallet.configError || 'Sign-in is being set up. Please try again later.';
  const solanaSelected = wallet.addresses.solana;
  const evmSelected = wallet.addresses.ethereum?.toLowerCase() ?? null;
  return (
    <div className="set-screen">
      <SettingsSection id="set-account" title="Account">
        <SettingsRow title="ANTARA account" description={accountText}>
          {wallet.authenticated ? (
            <button type="button" className="ui-btn" onClick={() => void signOut()}>Sign out</button>
          ) : (
            <button type="button" className="ui-btn-primary" disabled={wallet.configured && !wallet.ready} onClick={onSignIn}>
              {wallet.configured && !wallet.ready ? 'Wallet loading…' : 'Sign in'}
            </button>
          )}
        </SettingsRow>
        {wallet.authenticated && (
          <>
            <SettingsRow title="External signers" description="Add another wallet to your account.">
              <button type="button" className="ui-btn" onClick={wallet.connectWallet}>Connect external wallet</button>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection id="set-wallets" title="Wallets">
        {signedOut ? (
          <p className="set-note">Sign in to see your wallets</p>
        ) : (
          <>
            <WalletGroup id="set-wallets-solana" family="solana" title="Solana" logo="solana" empty="No Solana wallet on this account."
              wallets={wallet.solanaSigners} isSelected={address => address === solanaSelected} />
            <WalletGroup id="set-wallets-evm" family="evm" title={EVM_FAMILY} logo="ethereum" empty="No EVM wallet on this account."
              wallets={wallet.evmSigners} isSelected={address => address.toLowerCase() === evmSelected} />
            <SettingsRow title="Selected wallets" description="Balances, sends and swaps use the selected wallet on each network family.">
              <button type="button" className="ui-btn" onClick={onOpenAccounts}>Switch wallet</button>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection id="set-address-book" title="Address book" ref={addressBookSection} focusTarget={section === 'address-book'}>
        {isMobile ? (
          AddressBookScreen ? (
            <SettingsRow title="Saved addresses" description="Saved recipients and your own wallets, on this device.">
              <button ref={addressBookOpener} type="button" className="ui-btn" aria-label="Open address book" onClick={() => setAddressBookPage(true)}>
                Open <Icon name="arrow" size={15} />
              </button>
            </SettingsRow>
          ) : <AddressBookBody />
        ) : (
          <div className="set-addressbook-inline"><AddressBookBody /></div>
        )}
      </SettingsSection>

      <SettingsSection id="set-security" title="Security">
        <SettingsRow
          title="Your Solana vault"
          description={signedOut ? 'Sign in to view your vault' : 'The vault paired with your selected Solana wallet.'}
          extra={vaultStatus && <div className="set-row-status"><StatusChip tone={vaultStatus.tone} label={vaultStatus.label} /></div>}
        >
          <button type="button" className="ui-btn" aria-label="Open your Solana vault" onClick={() => onNavigate('#vault')}>Open</button>
        </SettingsRow>
        <SettingsRow title="Vault protection layers" description="Passkey, safe zones, Wi-Fi, Bluetooth, an authenticator code and your own caps, for your vault’s releases.">
          <button type="button" className="ui-btn" aria-label="Manage vault protection layers" onClick={() => onNavigate('#vaultlayers')}>Manage</button>
        </SettingsRow>
        <SettingsRow title="Your protection" description="Your vault’s protection layers and their status, in one place.">
          <button type="button" className="ui-btn" aria-label="Open your protection" onClick={() => onNavigate('#protection')}>Open</button>
        </SettingsRow>
        <SettingsRow title="Existing multisig vaults" description="Access funds in a Safe or Squads vault you already use.">
          <button type="button" className="ui-btn" aria-expanded={existingVaults} aria-controls="set-existing-vaults" onClick={() => setExistingVaults(open => !open)}>
            {existingVaults ? 'Close' : 'Manage existing'}
          </button>
        </SettingsRow>
        {existingVaults && (
          <div id="set-existing-vaults" className="set-embed">
            <Suspense fallback={<p className="set-note" role="status">Loading workspace…</p>}>
              <VaultWorkspace />
            </Suspense>
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="set-preferences" title="Preferences">
        <SettingsRow title="Celestial motion" description="Ambient stars and gentle transitions. Follows your system’s reduced-motion preference.">
          <SettingsSwitch label="Celestial motion" checked={motion} onChange={onMotion} />
        </SettingsRow>
        <SettingsRow title="Hide balances" description="Remember balance privacy on this device.">
          <SettingsSwitch label="Hide balances" checked={privacy} onChange={onPrivacy} />
        </SettingsRow>
        {!isMobile && (
          <SettingsRow title="Navigation labels" description="Expand the icon navigation.">
            <SettingsSwitch label="Show navigation labels" checked={navExpanded} onChange={onNavExpanded} />
          </SettingsRow>
        )}
      </SettingsSection>

      <NetworksPanel />
      <AboutPanel />
    </div>
  );
}

function WalletGroup({ id, family, title, logo, empty, wallets, isSelected }: {
  id: string;
  family: 'solana' | 'evm';
  title: string;
  logo: 'solana' | 'ethereum';
  empty: string;
  wallets: readonly WalletSigner[];
  isSelected: (address: string) => boolean;
}) {
  return (
    <div className="set-wallet-group" role="group" aria-labelledby={id}>
      <h3 id={id} className="set-group-title">{title}</h3>
      {wallets.length ? (
        <ul className="set-wallet-list">
          {wallets.map(item => {
            const identity = walletIdentity(item, family);
            return (
              <li key={item.address} className="set-wallet">
                <span className="set-wallet-logo"><TokenLogo symbol={logo} /></span>
                <span className="set-wallet-text">
                  <span className="set-wallet-title">
                    <span className="set-wallet-name">{identity.label}</span>
                    {identity.hint && <span className="set-wallet-tag">{identity.hint}</span>}
                  </span>
                  <AddressText address={item.address} form="short" copy copyLabel={`Copy ${identity.label} address`} />
                </span>
                {isSelected(item.address) && <StatusChip label="Selected" className="set-wallet-selected" />}
                <WalletSettingsButton family={family} signer={item} className="set-wallet-cog" />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="set-note">{empty}</p>
      )}
    </div>
  );
}

/** Area B's screen when present; otherwise a plain statement that this build has no address book yet. */
function AddressBookBody({ onBack }: { onBack?: () => void }) {
  if (AddressBookScreen) {
    return (
      <Suspense fallback={<p className="set-note" role="status">Loading address book…</p>}>
        <AddressBookScreen onBack={onBack} />
      </Suspense>
    );
  }
  return (
    <div className="set-addressbook-missing">
      {onBack && <button type="button" className="ui-btn-text" onClick={onBack}><Icon name="back" size={16} /> Back</button>}
      <p className="set-note">The address book is not available in this build yet.</p>
    </div>
  );
}
