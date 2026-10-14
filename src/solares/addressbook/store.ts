/**
 * Address book store (docs/UI_ARGUS_PARITY.md 6.9, 8.3): saved recipients, local to this
 * device and to one Privy user. No network calls, no sync.
 *
 * - One localStorage value per user: `solares.address-book.v1:<privy user id>`, holding
 *   `{ "version": 1, "entries": [...] }`, newest first.
 * - Reading never throws. A value that is not exactly a valid book (bad JSON, an unknown
 *   version, one malformed or duplicate entry, more than 200 entries) is `unreadable`,
 *   and nothing in this module overwrites it: saving and removing refuse, and only
 *   `resetUnreadable()` clears it, which the screen calls after the person confirms.
 * - Storage that throws on access is `unavailable` ("This device does not allow ANTARA to
 *   save addresses"); Send still takes pasted addresses.
 * - Addresses are validated and stored canonically: Solana as `PublicKey.toBase58()` (the
 *   system program refused), EVM checksummed with `getAddress()` (zero refused).
 * - Every write dispatches `solares:address-book` on `window`, for screens on this page;
 *   other tabs see the `storage` event.
 * - Recent recipients are derived from `transferHistory()`, never stored here.
 */
import { PublicKey } from '@solana/web3.js';
import { getAddress, isAddress } from 'viem';
import { isNetworkKey } from '../networks';
import { transferHistory } from '../transfers/transfer';
import { familyOf, sameAddress, type AddressFamily } from './family';

export type { AddressFamily } from './family';
export { lookalike, lookalikeWarning, type LookalikeCandidate } from './poisoning';

export interface AddressEntry { id: string; label: string; family: AddressFamily; address: string; createdAt: string; updatedAt: string }
export type AddressBookRead =
  | { status: 'ok'; entries: AddressEntry[] }
  | { status: 'unreadable' }
  | { status: 'unavailable' }
  | { status: 'signed-out' };

export const ADDRESS_BOOK_KEY = (privyUserId: string) => `solares.address-book.v1:${privyUserId}`;
/** Same-page change event (8.4 pattern). */
export const ADDRESS_BOOK_EVENT = 'solares:address-book';
export const MAX_ENTRIES = 200;
export const MAX_LABEL_LENGTH = 40;
const VERSION = 1;

/** Every user-facing string of the store and its screens (6.9). */
export const ADDRESS_BOOK_COPY = Object.freeze({
  signedOut: 'Sign in to use your address book.',
  empty: 'No saved addresses yet. Addresses you save stay on this device for this account.',
  unreadable: 'Saved addresses on this device could not be read. Nothing was changed.',
  unavailable: 'This device does not allow ANTARA to save addresses. You can still paste addresses when sending.',
  footer: 'Saved on this device only. Not synced to your other devices or the ANTARA extension.',
  invalidSolana: 'Enter a valid Solana address.',
  systemProgram: 'The system program is not a receiving wallet.',
  invalidEvm: 'Enter a valid, nonzero EVM address.',
  noName: 'Enter a name.',
  longName: `Use a name of ${MAX_LABEL_LENGTH} characters or fewer.`,
  controlName: 'Names cannot contain line breaks or control characters.',
  noFamily: 'Choose Solana or EVM.',
  full: `You can save up to ${MAX_ENTRIES} addresses on this device.`,
  removed: 'This saved address was removed. Add it again.',
  duplicate: (label: string) => `This address is already saved as ${label}.`,
  removeConfirm: (label: string) => `Remove ${label}? This only removes it from this device.`,
});

/** A refused save, with the copy to show next to the form. */
export class AddressBookError extends Error {
  constructor(message: string) { super(message); this.name = 'AddressBookError'; }
}

/** C0 and C1 controls, plus the bidirectional overrides that can make a name read as another. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/** The label as stored: trimmed, 1–40 characters, no control characters. Throws the 6.9 copy. */
export function cleanLabel(input: string): string {
  const label = String(input ?? '').trim();
  if (!label) throw new AddressBookError(ADDRESS_BOOK_COPY.noName);
  if (CONTROL.test(label)) throw new AddressBookError(ADDRESS_BOOK_COPY.controlName);
  if ([...label].length > MAX_LABEL_LENGTH) throw new AddressBookError(ADDRESS_BOOK_COPY.longName);
  return label;
}

/** The canonical form of a valid address for its family. Throws the 6.9 copy. */
export function canonicalAddress(family: AddressFamily, input: string): string {
  const value = String(input ?? '').trim();
  if (family === 'solana') {
    let key: PublicKey;
    try { key = new PublicKey(value); } catch { throw new AddressBookError(ADDRESS_BOOK_COPY.invalidSolana); }
    if (!value) throw new AddressBookError(ADDRESS_BOOK_COPY.invalidSolana);
    if (key.equals(PublicKey.default)) throw new AddressBookError(ADDRESS_BOOK_COPY.systemProgram);
    return key.toBase58();
  }
  if (family === 'evm') {
    // Strict, like transfers: a mixed-case address with a wrong checksum is refused (likely a typo).
    if (!isAddress(value) || /^0x0{40}$/i.test(value)) throw new AddressBookError(ADDRESS_BOOK_COPY.invalidEvm);
    return getAddress(value);
  }
  throw new AddressBookError(ADDRESS_BOOK_COPY.noFamily);
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

function validEntry(value: unknown): value is AddressEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) return false;
  if (entry.family !== 'solana' && entry.family !== 'evm') return false;
  if (typeof entry.label !== 'string' || typeof entry.address !== 'string' || !isTime(entry.createdAt) || !isTime(entry.updatedAt)) return false;
  try {
    // Stored values are already canonical; anything else was not written by this module.
    return cleanLabel(entry.label) === entry.label && canonicalAddress(entry.family, entry.address) === entry.address;
  } catch {
    return false;
  }
}

/** The entries of a stored value, or null when it is not exactly a valid book. */
function parseBook(raw: string): AddressEntry[] | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const book = value as { version?: unknown; entries?: unknown };
  if (book.version !== VERSION || !Array.isArray(book.entries) || book.entries.length > MAX_ENTRIES) return null;
  if (!book.entries.every(validEntry)) return null;
  const entries = book.entries.map(entry => ({ id: entry.id, label: entry.label, family: entry.family, address: entry.address, createdAt: entry.createdAt, updatedAt: entry.updatedAt }));
  const ids = new Set(entries.map(entry => entry.id));
  const addresses = new Set(entries.map(entry => `${entry.family}:${entry.family === 'evm' ? entry.address.toLowerCase() : entry.address}`));
  return ids.size === entries.length && addresses.size === entries.length ? entries : null;
}

function announce() {
  const target = (globalThis as { window?: EventTarget }).window;
  target?.dispatchEvent?.(new Event(ADDRESS_BOOK_EVENT));
}

export function readAddressBook(privyUserId: string | null): AddressBookRead {
  if (!privyUserId) return { status: 'signed-out' };
  let raw: string | null;
  try { raw = globalThis.localStorage.getItem(ADDRESS_BOOK_KEY(privyUserId)); } catch { return { status: 'unavailable' }; }
  if (raw === null) return { status: 'ok', entries: [] };
  const entries = parseBook(raw);
  return entries ? { status: 'ok', entries } : { status: 'unreadable' };
}

/** The current entries, or the refusal for a book this module must not change. */
function writable(privyUserId: string | null): AddressEntry[] {
  if (!privyUserId) throw new AddressBookError(ADDRESS_BOOK_COPY.signedOut);
  const book = readAddressBook(privyUserId);
  if (book.status === 'unavailable') throw new AddressBookError(ADDRESS_BOOK_COPY.unavailable);
  if (book.status !== 'ok') throw new AddressBookError(ADDRESS_BOOK_COPY.unreadable);
  return book.entries;
}

function write(privyUserId: string, entries: AddressEntry[]) {
  try { globalThis.localStorage.setItem(ADDRESS_BOOK_KEY(privyUserId), JSON.stringify({ version: VERSION, entries })); }
  catch { throw new AddressBookError(ADDRESS_BOOK_COPY.unavailable); }
  announce();
}

/** Adds an entry, or edits entry `id`. Throws an AddressBookError with the 6.9 copy. */
export function saveEntry(privyUserId: string, input: { label: string; family: AddressFamily; address: string }, id?: string): AddressEntry {
  const entries = writable(privyUserId);
  const label = cleanLabel(input.label);
  const address = canonicalAddress(input.family, input.address);
  const existing = id === undefined ? undefined : entries.find(entry => entry.id === id);
  if (id !== undefined && !existing) throw new AddressBookError(ADDRESS_BOOK_COPY.removed);
  const duplicate = entries.find(entry => entry.id !== id && entry.family === input.family && sameAddress(input.family, entry.address, address));
  if (duplicate) throw new AddressBookError(ADDRESS_BOOK_COPY.duplicate(duplicate.label));
  if (!existing && entries.length >= MAX_ENTRIES) throw new AddressBookError(ADDRESS_BOOK_COPY.full);
  const now = new Date().toISOString();
  const entry: AddressEntry = existing
    ? { ...existing, label, family: input.family, address, updatedAt: now }
    : { id: globalThis.crypto.randomUUID(), label, family: input.family, address, createdAt: now, updatedAt: now };
  write(privyUserId, existing ? entries.map(item => (item.id === entry.id ? entry : item)) : [entry, ...entries]);
  return entry;
}

export function removeEntry(privyUserId: string, id: string): void {
  const entries = writable(privyUserId);
  if (!entries.some(entry => entry.id === id)) return;
  write(privyUserId, entries.filter(entry => entry.id !== id));
}

/**
 * Clears an unreadable book. Call only after the person confirmed "Clear and start
 * again". A readable book is never cleared by this function.
 */
export function resetUnreadable(privyUserId: string): void {
  if (readAddressBook(privyUserId).status !== 'unreadable') return;
  try { globalThis.localStorage.removeItem(ADDRESS_BOOK_KEY(privyUserId)); }
  catch { throw new AddressBookError(ADDRESS_BOOK_COPY.unavailable); }
  announce();
}

/**
 * The last `limit` unique recipients of this user's submitted or confirmed transfers on
 * supported networks of `family`, newest first, in canonical form. Derived from the
 * device's transfer history (transfers/transfer.ts); nothing extra is stored.
 */
export function recentRecipients(privyUserId: string, family: AddressFamily, limit = 10): string[] {
  const time = (value: string) => Date.parse(value) || 0;
  const records = transferHistory(privyUserId)
    .filter(record => (record.status === 'submitted' || record.status === 'confirmed') && isNetworkKey(record.chain) && familyOf(record.chain) === family && typeof record.recipient === 'string')
    .sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const seen = new Set<string>();
  const recents: string[] = [];
  for (const record of records) {
    if (recents.length >= limit) break;
    let address: string;
    try { address = canonicalAddress(family, record.recipient); } catch { continue; }
    const key = family === 'evm' ? address.toLowerCase() : address;
    if (seen.has(key)) continue;
    seen.add(key);
    recents.push(address);
  }
  return recents;
}
