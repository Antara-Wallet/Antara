/**
 * Live view of one user's address book and recent recipients for the address book
 * screen, the Send picker and Send's recognised-recipient chips (6.9). Re-reads on mount,
 * on `solares:address-book` (store writes on this page), on `solares:transfers` (a send
 * on this page changes the recents) and on `storage` events from other tabs.
 */
import { useEffect, useMemo, useState } from 'react';
import { ADDRESS_BOOK_EVENT, ADDRESS_BOOK_KEY, readAddressBook, recentRecipients, type AddressBookRead, type AddressFamily } from './store';
import { sameAddress } from './family';
import { vaultAddresses, type VaultSummaryInput } from '../receive/vaultTarget';
import type { SolaresWalletState, WalletSigner } from '../wallet/types';
import { walletIdentity } from '../wallet/walletIdentity';

const TRANSFERS_EVENT = 'solares:transfers';

export interface AddressBookView {
  book: AddressBookRead;
  recents: Readonly<Record<AddressFamily, readonly string[]>>;
}

export function useAddressBook(privyUserId: string | null): AddressBookView {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(value => value + 1);
    const onStorage = (event: StorageEvent) => {
      if (!privyUserId || event.key === null || event.key === ADDRESS_BOOK_KEY(privyUserId) || event.key === `solares:transfers:${privyUserId}`) bump();
    };
    window.addEventListener(ADDRESS_BOOK_EVENT, bump);
    window.addEventListener(TRANSFERS_EVENT, bump);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(ADDRESS_BOOK_EVENT, bump);
      window.removeEventListener(TRANSFERS_EVENT, bump);
      window.removeEventListener('storage', onStorage);
    };
  }, [privyUserId]);
  // `version` is a dependency only so an event re-runs the reads.
  return useMemo(() => ({
    book: readAddressBook(privyUserId),
    recents: privyUserId
      ? { solana: recentRecipients(privyUserId, 'solana'), evm: recentRecipients(privyUserId, 'evm') }
      : { solana: [], evm: [] },
  }), [privyUserId, version]);
}

export interface OwnAddress {
  name: string; family: AddressFamily; address: string; vault: boolean;
  /** A wallet whose keys live in another app (Phantom, MetaMask, …), shown with an "External" tag. */
  external: boolean;
}

/**
 * Your own addresses, Solana first: the Solana signers, the EVM signers and, only when
 * the vault summary is `active`, "Your Solana vault" (its verified deposit address).
 * Wallets are named as everywhere else (walletIdentity): "ANTARA wallet", never "Privy".
 */
export function ownAddresses(wallet: Pick<SolaresWalletState, 'authenticated' | 'solanaSigners' | 'evmSigners'>, vaultSummary?: VaultSummaryInput | null): OwnAddress[] {
  if (!wallet.authenticated) return [];
  const vault = vaultAddresses(vaultSummary);
  const own = (signer: WalletSigner, family: AddressFamily): OwnAddress => {
    const identity = walletIdentity(signer, family);
    return { name: identity.label, family, address: signer.address, vault: false, external: !identity.embedded };
  };
  return [
    ...wallet.solanaSigners.map(signer => own(signer, 'solana')),
    ...(vault?.active ? [{ name: 'Your Solana vault', family: 'solana' as const, address: vault.depositAddress, vault: true, external: false }] : []),
    ...wallet.evmSigners.map(signer => own(signer, 'evm')),
  ];
}

/** The saved entry for an address, if any. */
export function savedEntryFor(book: AddressBookRead, family: AddressFamily, address: string) {
  return book.status === 'ok' ? book.entries.find(entry => entry.family === family && sameAddress(family, entry.address, address)) : undefined;
}

/** Case-insensitive match on name/label or address, for the screen's and picker's search. */
export function matchesQuery(query: string, ...fields: string[]) {
  const value = query.trim().toLowerCase();
  return !value || fields.some(field => field.toLowerCase().includes(value));
}
