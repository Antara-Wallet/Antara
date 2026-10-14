// Address book (docs/UI_ARGUS_PARITY.md 6.9; ARGUS S12, argus-ext-popup-12-address-book.png).
// Settings › Address book (#addressbook): your own wallets, recent recipients derived
// from this device's transfers, and saved addresses. Local to this device and to the
// signed-in Privy user; nothing is synced.
import { useMemo, useState, type ReactNode } from 'react';
import { useSolaresWallet } from '../wallet';
import { AddressText, COPY_MESSAGES, Icon, Sheet, copyText, useToast } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { ADDRESS_BOOK_COPY, removeEntry, resetUnreadable, type AddressEntry, type AddressFamily } from './store';
import { ADDRESS_FAMILIES, FAMILY_CHIP } from './family';
import { matchesQuery, ownAddresses, savedEntryFor, useAddressBook } from './useAddressBook';
import { AddressForm } from './AddressForm';
import type { VaultSummaryInput } from '../receive/vaultTarget';
import './addressbook.css';

export interface AddressBookScreenProps {
  /** Narrow sub-page: shows Back. */
  onBack?: () => void;
  /** The vault summary (8.2). "Your Solana vault" is listed only when it is `active`. */
  vaultSummary?: VaultSummaryInput | null;
}

type FormState = { entry?: AddressEntry; initial?: { family: AddressFamily; address: string } } | null;

export function AddressBookScreen({ onBack, vaultSummary }: AddressBookScreenProps) {
  const wallet = useSolaresWallet();
  const userId = wallet.authenticated ? wallet.userId : null;
  const { book, recents } = useAddressBook(userId);
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<FormState>(null);
  const [removing, setRemoving] = useState<AddressEntry | null>(null);
  const [clearing, setClearing] = useState(false);
  const [problem, setProblem] = useState('');

  const own = useMemo(() => ownAddresses(wallet, vaultSummary).filter(item => matchesQuery(query, item.name, item.address)), [wallet, vaultSummary, query]);
  const recentRows = ADDRESS_FAMILIES.flatMap(family => recents[family].map(address => ({ family, address })))
    .filter(item => matchesQuery(query, item.address, savedEntryFor(book, item.family, item.address)?.label ?? ''));
  const saved = book.status === 'ok'
    ? [...book.entries].sort((a, b) => a.label.localeCompare(b.label)).filter(entry => matchesQuery(query, entry.label, entry.address))
    : [];
  const canSave = !!userId && book.status === 'ok';

  function confirmRemove() {
    if (!userId || !removing) return;
    try { removeEntry(userId, removing.id); toast.show(`${removing.label} removed.`); setProblem(''); }
    catch (error) { setProblem(error instanceof Error ? error.message : ADDRESS_BOOK_COPY.unreadable); }
    setRemoving(null);
  }
  function confirmClear() {
    if (!userId) return;
    try { resetUnreadable(userId); toast.show('Saved addresses cleared on this device.'); setProblem(''); }
    catch (error) { setProblem(error instanceof Error ? error.message : ADDRESS_BOOK_COPY.unavailable); }
    setClearing(false);
  }

  return (
    <section className="ab-screen ui-scope" aria-labelledby="ab-title" data-screen="address-book">
      <header className="ab-header">
        {onBack && (
          <button type="button" className="ui-icon-btn" aria-label="Back to settings" onClick={onBack}><Icon name="back" /></button>
        )}
        <h2 id="ab-title" className="ab-title">Address book</h2>
        {userId && (
          <button type="button" className="ui-btn ab-add" disabled={!canSave} onClick={() => setForm({})}>
            <Icon name="plus" size={16} /> Add address
          </button>
        )}
      </header>

      {!userId ? (
        <div className="ui-card ab-empty-card">
          <span className="ab-empty-icon" aria-hidden="true"><Icon name="book" size={22} /></span>
          <p>{ADDRESS_BOOK_COPY.signedOut}</p>
        </div>
      ) : (
        <>
          <label className="ab-search">
            <Icon name="search" size={16} />
            <input type="search" className="ab-search-input" placeholder="Search names or addresses" aria-label="Search names or addresses" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>

          {problem && <p className="ui-alert" role="alert">{problem}</p>}

          <AddressSection title="Your wallets" empty={query ? 'No matching wallets.' : 'No wallets connected.'} count={own.length}>
            {own.map(item => (
              <li key={`${item.family}:${item.address}`} className="ab-row">
                <span className="ab-logo" aria-hidden="true">{item.vault ? <Icon name="vault" size={17} /> : <TokenLogo symbol={item.family === 'solana' ? 'solana' : 'ethereum'} />}</span>
                <span className="ab-main">
                  <span className="ab-name">{item.name}</span>
                  <span className="ab-meta"><span className="ab-chip">{FAMILY_CHIP[item.family]}</span>{item.external && <span className="ab-chip">External</span>}<AddressText address={item.address} form="short" /></span>
                </span>
                <span className="ab-actions">
                  <CopyButton address={item.address} label={`Copy ${item.name} address`} />
                </span>
              </li>
            ))}
          </AddressSection>

          <AddressSection title="Recent" empty={query ? 'No matching recipients.' : 'Recipients of transfers sent from this device appear here.'} count={recentRows.length}>
            {recentRows.map(item => {
              const entry = savedEntryFor(book, item.family, item.address);
              return (
                <li key={`${item.family}:${item.address}`} className="ab-row">
                  <span className="ab-logo" aria-hidden="true"><Icon name="up" size={16} /></span>
                  <span className="ab-main">
                    <span className="ab-name">{entry ? entry.label : 'Recent recipient'}</span>
                    <span className="ab-meta"><span className="ab-chip">{FAMILY_CHIP[item.family]}</span><AddressText address={item.address} form="short" /></span>
                  </span>
                  <span className="ab-actions">
                    <CopyButton address={item.address} label={`Copy recent ${FAMILY_CHIP[item.family]} address`} />
                    {!entry && canSave && (
                      <button type="button" className="ui-btn-text ab-text-action" onClick={() => setForm({ initial: item })} aria-label={`Save recent address ${item.address}`}>Save</button>
                    )}
                  </span>
                </li>
              );
            })}
          </AddressSection>

          {book.status === 'unreadable' ? (
            <div className="ab-section">
              <h3 className="ui-eyebrow ab-section-title">Saved</h3>
              <div className="ui-alert ab-alert" role="alert" data-tone="warn">
                <p>{ADDRESS_BOOK_COPY.unreadable}</p>
                <button type="button" className="ui-btn-danger" onClick={() => setClearing(true)}>Clear and start again</button>
              </div>
            </div>
          ) : book.status === 'unavailable' ? (
            <div className="ab-section">
              <h3 className="ui-eyebrow ab-section-title">Saved</h3>
              <p className="ui-alert" role="alert" data-tone="neutral">{ADDRESS_BOOK_COPY.unavailable}</p>
            </div>
          ) : (
            <AddressSection title="Saved" count={saved.length} empty={query ? 'No matching saved addresses.' : ADDRESS_BOOK_COPY.empty} emptyArt>
              {saved.map(entry => (
                <li key={entry.id} className="ab-row">
                  <span className="ab-logo" aria-hidden="true"><TokenLogo symbol={entry.family === 'solana' ? 'solana' : 'ethereum'} /></span>
                  <span className="ab-main">
                    <span className="ab-name">{entry.label}</span>
                    <span className="ab-meta"><span className="ab-chip">{FAMILY_CHIP[entry.family]}</span><AddressText address={entry.address} form="short" /></span>
                  </span>
                  <span className="ab-actions">
                    <CopyButton address={entry.address} label={`Copy ${entry.label} address`} />
                    <button type="button" className="ui-btn-text ab-text-action" onClick={() => setForm({ entry })} aria-label={`Edit ${entry.label}`}>Edit</button>
                    <button type="button" className="ui-btn-text ab-text-action ab-remove" onClick={() => setRemoving(entry)} aria-label={`Remove ${entry.label}`}>Remove</button>
                  </span>
                </li>
              ))}
            </AddressSection>
          )}
        </>
      )}

      <p className="ab-footnote">{ADDRESS_BOOK_COPY.footer}</p>

      {form && userId && (
        <AddressForm privyUserId={userId} entry={form.entry} initial={form.initial} lockFamily={!!form.initial} onClose={() => setForm(null)} />
      )}
      {removing && (
        <Sheet
          title="Remove address"
          closeLabel="Keep address"
          onClose={() => setRemoving(null)}
          footer={<>
            <button type="button" className="ui-btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button type="button" className="ui-btn-danger" onClick={confirmRemove}>Remove</button>
          </>}
        >
          <p className="ab-confirm">{ADDRESS_BOOK_COPY.removeConfirm(removing.label)}</p>
        </Sheet>
      )}
      {clearing && (
        <Sheet
          title="Clear saved addresses"
          closeLabel="Keep saved addresses"
          onClose={() => setClearing(false)}
          footer={<>
            <button type="button" className="ui-btn" onClick={() => setClearing(false)}>Cancel</button>
            <button type="button" className="ui-btn-danger" onClick={confirmClear}>Clear and start again</button>
          </>}
        >
          <p className="ab-confirm">The saved addresses stored on this device for this account cannot be read. Clearing deletes them here and starts an empty address book. Transfers and other devices are not affected.</p>
        </Sheet>
      )}
    </section>
  );
}

function AddressSection({ title, count, empty, emptyArt = false, children }: { title: string; count: number; empty: string; emptyArt?: boolean; children: ReactNode }) {
  return (
    <div className="ab-section">
      <h3 className="ui-eyebrow ab-section-title">{title}</h3>
      {count ? <ul className="ui-card ab-list">{children}</ul> : (
        <div className="ui-card ab-empty-card" data-compact={!emptyArt || undefined}>
          {emptyArt && <span className="ab-empty-icon" aria-hidden="true"><Icon name="book" size={22} /></span>}
          <p>{empty}</p>
        </div>
      )}
    </div>
  );
}

/** Icon copy button with the shell's toast ("Address copied." or the clipboard fallback). */
export function CopyButton({ address, label, message = COPY_MESSAGES.copied }: { address: string; label: string; message?: string }) {
  const toast = useToast();
  return (
    <button type="button" className="ui-icon-btn ab-icon-action" aria-label={label} onClick={async () => {
      toast.show((await copyText(address)) === 'copied' ? message : COPY_MESSAGES.unavailable);
    }}>
      <Icon name="copy" size={16} />
    </button>
  );
}
