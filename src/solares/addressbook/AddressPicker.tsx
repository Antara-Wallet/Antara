// Address book picker for Send's recipient (docs/UI_ARGUS_PARITY.md 6.8, 6.9): the same
// sections as the address book, filtered to the Send network's family. Choosing an entry
// returns its address to Details. "Your Solana vault" appears only when the vault is
// active, and picking it hands off to the vault's Deposit, never a plain transfer.
import { useMemo, useState, type ReactNode } from 'react';
import { useSolaresWallet } from '../wallet';
import { AddressText, Icon, Sheet } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { ADDRESS_BOOK_COPY, type AddressFamily } from './store';
import { sameAddress } from './family';
import { matchesQuery, ownAddresses, savedEntryFor, useAddressBook } from './useAddressBook';
import type { VaultSummaryInput } from '../receive/vaultTarget';
import './addressbook.css';

export interface AddressPick { address: string; label: string; source: 'own' | 'vault' | 'recent' | 'saved' }

export interface AddressPickerProps {
  family: AddressFamily;
  /** The sending wallet: never offered as its own recipient. */
  exclude?: string | null;
  vaultSummary?: VaultSummaryInput | null;
  onPick: (pick: AddressPick) => void;
  onClose: () => void;
}

export function AddressPicker({ family, exclude, vaultSummary, onPick, onClose }: AddressPickerProps) {
  const wallet = useSolaresWallet();
  const userId = wallet.authenticated ? wallet.userId : null;
  const { book, recents } = useAddressBook(userId);
  const [query, setQuery] = useState('');
  const familyName = family === 'solana' ? 'Solana' : 'EVM';

  const own = useMemo(() => ownAddresses(wallet, vaultSummary)
    .filter(item => item.family === family && !(exclude && sameAddress(family, item.address, exclude)))
    .filter(item => matchesQuery(query, item.name, item.address)), [wallet, vaultSummary, family, exclude, query]);
  const recent = recents[family]
    .filter(address => !(exclude && sameAddress(family, address, exclude)))
    .map(address => ({ address, label: savedEntryFor(book, family, address)?.label ?? 'Recent recipient' }))
    .filter(item => matchesQuery(query, item.label, item.address));
  const saved = book.status === 'ok'
    ? book.entries.filter(entry => entry.family === family).sort((a, b) => a.label.localeCompare(b.label)).filter(entry => matchesQuery(query, entry.label, entry.address))
    : [];
  const nothing = !own.length && !recent.length && !saved.length;

  const row = (key: string, pick: AddressPick, icon: ReactNode) => (
    <li key={key}>
      <button type="button" className="ab-row ab-pick" onClick={() => onPick(pick)}>
        <span className="ab-logo" aria-hidden="true">{icon}</span>
        <span className="ab-main">
          <span className="ab-name">{pick.label}</span>
          <span className="ab-meta"><AddressText address={pick.address} form="short" /></span>
        </span>
        <Icon name="arrow" size={16} />
      </button>
    </li>
  );
  const logo = <TokenLogo symbol={family === 'solana' ? 'solana' : 'ethereum'} />;

  return (
    <Sheet title="Address book" description={`Showing ${familyName} addresses`} closeLabel="Close address book" onClose={onClose} className="ab-picker-sheet">
      <div className="ab-picker">
        <label className="ab-search">
          <Icon name="search" size={16} />
          <input type="search" className="ab-search-input" placeholder="Search names or addresses" aria-label="Search names or addresses" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {own.length > 0 && (
          <div className="ab-section">
            <h3 className="ui-eyebrow ab-section-title">Your wallets</h3>
            <ul className="ui-card ab-list">
              {own.map(item => row(`own:${item.address}`, { address: item.address, label: item.name, source: item.vault ? 'vault' : 'own' }, item.vault ? <Icon name="vault" size={17} /> : logo))}
            </ul>
          </div>
        )}
        {recent.length > 0 && (
          <div className="ab-section">
            <h3 className="ui-eyebrow ab-section-title">Recent</h3>
            <ul className="ui-card ab-list">
              {recent.map(item => row(`recent:${item.address}`, { address: item.address, label: item.label, source: 'recent' }, <Icon name="up" size={16} />))}
            </ul>
          </div>
        )}
        {saved.length > 0 && (
          <div className="ab-section">
            <h3 className="ui-eyebrow ab-section-title">Saved</h3>
            <ul className="ui-card ab-list">
              {saved.map(entry => row(`saved:${entry.id}`, { address: entry.address, label: entry.label, source: 'saved' }, logo))}
            </ul>
          </div>
        )}
        {book.status === 'unreadable' && <p className="ui-alert" data-tone="warn">{ADDRESS_BOOK_COPY.unreadable}</p>}
        {book.status === 'unavailable' && <p className="ui-alert" data-tone="neutral">{ADDRESS_BOOK_COPY.unavailable}</p>}
        {nothing && (
          <div className="ui-card ab-empty-card">
            <span className="ab-empty-icon" aria-hidden="true"><Icon name="book" size={22} /></span>
            <p>{query ? 'No matching addresses.' : `No ${familyName} addresses yet. Paste an address, or save one after a transfer.`}</p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
