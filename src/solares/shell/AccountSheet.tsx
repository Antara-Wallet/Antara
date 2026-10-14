// Account sheet, "Wallets" (docs/UI_ARGUS_PARITY.md 6.3; ARGUS address dropdown, account
// sidebar and Add Wallet). A right-anchored 380px drawer on desktop, a bottom sheet when
// narrow. Solana wallets first, then EVM, then the account actions. The only way to add a
// wallet is "Connect external wallet": ANTARA never imports, creates or tracks keys.
//
// The account's Privy embedded wallets are the "ANTARA wallet"; external wallets keep their
// name with an "External" tag. Every row has a settings cog (WalletSettings.tsx): address,
// explorer and, for the ANTARA wallet, Privy's secure "Export private key". The Vault row
// sits only under the ANTARA Solana wallet.
//
// Asserted by the browser specs: the dialog's only h3 headings are "Solana" and
// "EVM · …"; a Solana row is a button whose name starts with its wallet name; EVM rows
// likewise ("Wallet two"); each cog is "Wallet settings for <name> …".
import { Icon, Sheet, StatusChip, shortAddress } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { useSolaresWallet } from '../wallet';
import { walletIdentity } from '../wallet/walletIdentity';
import { hostedVaultStatus, vaultHost } from './accountModel';
import { ADDRESS_BOOK_AVAILABLE, usePairedVaultSummary } from './screens';
import { WalletSettingsButton } from './WalletSettings';

export interface AccountSheetProps {
  /** Must be referentially stable. */
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
  onSelect: (family: 'solana' | 'evm') => void;
  onOpenVault: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSettings: () => void;
  onAddressBook: () => void;
}

const EVM_GROUP = 'EVM · Ethereum, BNB Smart Chain, Robinhood Chain, Base';

export function AccountSheet({ onClose, returnFocusTo, onSelect, onOpenVault, onSignIn, onSignOut, onSettings, onAddressBook }: AccountSheetProps) {
  const wallet = useSolaresWallet();
  const summary = usePairedVaultSummary();
  const loading = wallet.configured && !wallet.ready;

  if (!wallet.authenticated) {
    return (
      <Sheet title="Wallets" onClose={onClose} returnFocusTo={returnFocusTo} size="drawer" className="shell-accounts-sheet">
        <div className="shell-accounts-empty">
          <span className="shell-accounts-empty-icon" aria-hidden="true"><Icon name="portfolio" size={26} /></span>
          <h3>Your ANTARA wallet</h3>
          <p>Sign in with your email to create or access your Solana and EVM wallets.</p>
          <button type="button" className="ui-btn-primary" disabled={loading} onClick={onSignIn}>
            {!wallet.configured ? 'Open setup' : loading ? 'Wallet loading…' : 'Sign in'}
          </button>
        </div>
      </Sheet>
    );
  }

  // The Vault row's host: the ANTARA Solana wallet (selected, else the first one).
  const host = vaultHost(wallet.solanaSigners, wallet.addresses.solana);
  const hostSelected = !!host && host.address === wallet.addresses.solana;
  const vault = host ? hostedVaultStatus(summary, hostSelected) : null;
  const openVault = () => {
    if (host && !hostSelected) { wallet.selectSolanaSigner(host.address); onSelect('solana'); }
    onOpenVault();
    onClose();
  };

  const evmSelected = wallet.addresses.ethereum?.toLowerCase() ?? null;
  const groups = [
    { family: 'solana' as const, label: 'Solana', signers: wallet.solanaSigners, isSelected: (address: string) => address === wallet.addresses.solana, select: wallet.selectSolanaSigner, logo: 'solana', empty: 'No Solana wallet on this account.' },
    { family: 'evm' as const, label: EVM_GROUP, signers: wallet.evmSigners, isSelected: (address: string) => address.toLowerCase() === evmSelected, select: wallet.selectEvmSigner, logo: 'ethereum', empty: 'No EVM wallet on this account.' },
  ];
  return (
    <Sheet title="Wallets" onClose={onClose} returnFocusTo={returnFocusTo} size="drawer" className="shell-accounts-sheet">
      <div className="shell-accounts">
        {groups.map(group => (
          <section key={group.family} className="shell-account-group" aria-label={group.label}>
            <h3 className="shell-account-heading">{group.label}</h3>
            {group.signers.length ? (
              <ul className="shell-account-list">
                {group.signers.map(signer => {
                  const selected = group.isSelected(signer.address);
                  const identity = walletIdentity(signer, group.family);
                  return (
                    <li key={signer.address} className="shell-account-item">
                      <div className="shell-account-card" data-current={selected || undefined}>
                        <button
                          type="button"
                          className="shell-account-row"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => { group.select(signer.address); onSelect(group.family); onClose(); }}
                        >
                          <span className="shell-account-logo" aria-hidden="true"><TokenLogo symbol={group.logo} /></span>
                          <span className="shell-account-text">
                            <span className="shell-account-name">
                              <strong>{identity.label}</strong>
                              {identity.hint && <span className="shell-account-tag">{identity.hint}</span>}
                            </span>
                            <small>{shortAddress(signer.address)}</small>
                          </span>
                          {selected && <Icon name="check" size={17} className="shell-account-check" />}
                        </button>
                        <WalletSettingsButton family={group.family} signer={signer} className="shell-account-cog" />
                      </div>
                      {group.family === 'solana' && host?.address === signer.address && vault && (
                        <button type="button" className="shell-vault-row" onClick={openVault}>
                          <span className="shell-vault-icon" aria-hidden="true"><Icon name="vault" size={16} /></span>
                          <span className="shell-vault-text">
                            <span className="shell-vault-name">Vault</span>
                            <StatusChip tone={vault.tone} label={vault.label} className="shell-vault-chip" />
                          </span>
                          <Icon name="arrow" size={15} className="shell-vault-arrow" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="shell-account-none">{group.empty}</p>
            )}
          </section>
        ))}
        <div className="shell-account-actions">
          <button type="button" className="ui-btn shell-account-action" onClick={() => { onClose(); wallet.connectWallet(); }}>
            <Icon name="plus" size={16} /> Connect external wallet
          </button>
          {ADDRESS_BOOK_AVAILABLE && (
            <button type="button" className="ui-btn shell-account-action" onClick={() => { onClose(); onAddressBook(); }}>
              <Icon name="book" size={16} /> Address book
            </button>
          )}
          <button type="button" className="ui-btn shell-account-action" onClick={() => { onClose(); onSettings(); }}>
            <Icon name="settings" size={16} /> Settings
          </button>
          <button type="button" className="ui-btn shell-account-action" onClick={() => { onClose(); onSignOut(); }}>
            <Icon name="lock" size={16} /> Sign out
          </button>
        </div>
      </div>
    </Sheet>
  );
}
