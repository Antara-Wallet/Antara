import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDRESS_BOOK_COPY, ADDRESS_BOOK_EVENT, ADDRESS_BOOK_KEY, AddressBookError, MAX_ENTRIES, canonicalAddress, cleanLabel,
  readAddressBook, recentRecipients, removeEntry, resetUnreadable, saveEntry,
} from './store';
import { FAMILY_OPTIONS, familyOf, sameAddress } from './family';

// Fixed public test keys (Keypair.fromSeed(fill(n))); never funded.
const SOL_A = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const SOL_B = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const EVM_LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const EVM_CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';

class MemoryStorage {
  values = new Map<string, string>();
  writes = 0;
  blocked = false;
  getItem(key: string) { if (this.blocked) throw new Error('SecurityError'); return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { if (this.blocked) throw new Error('SecurityError'); this.writes += 1; this.values.set(key, String(value)); }
  removeItem(key: string) { if (this.blocked) throw new Error('SecurityError'); this.writes += 1; this.values.delete(key); }
}

let storage: MemoryStorage;
let events: number;
let fetches: number;
const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  fetch: globalThis.fetch,
};

beforeEach(() => {
  storage = new MemoryStorage();
  events = 0;
  fetches = 0;
  const target = new EventTarget();
  target.addEventListener(ADDRESS_BOOK_EVENT, () => { events += 1; });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  globalThis.fetch = (async () => { fetches += 1; throw new Error('no network in the address book'); }) as typeof fetch;
});
afterEach(() => {
  for (const key of ['localStorage', 'window'] as const) {
    const original = originals[key];
    if (original) Object.defineProperty(globalThis, key, original);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  globalThis.fetch = originals.fetch;
});

test('a signed-out reader gets signed-out, never another user’s book', () => {
  assert.deepEqual(readAddressBook(null), { status: 'signed-out' });
  assert.throws(() => saveEntry('', { label: 'A', family: 'solana', address: SOL_A }), new AddressBookError(ADDRESS_BOOK_COPY.signedOut));
});

test('entries are per Privy user: user A’s entries are invisible to user B', () => {
  saveEntry('user-a', { label: 'Treasury', family: 'solana', address: SOL_A });
  const a = readAddressBook('user-a');
  assert.equal(a.status, 'ok');
  assert.equal(a.status === 'ok' && a.entries.length, 1);
  assert.deepEqual(readAddressBook('user-b'), { status: 'ok', entries: [] });
  assert.ok(storage.values.has(ADDRESS_BOOK_KEY('user-a')));
  assert.equal(ADDRESS_BOOK_KEY('user-a'), 'solares.address-book.v1:user-a');
  assert.equal(storage.values.has(ADDRESS_BOOK_KEY('user-b')), false);
});

test('a saved entry is trimmed and canonical, newest first, with timestamps', () => {
  const first = saveEntry('u', { label: '  Treasury  ', family: 'solana', address: `  ${SOL_A} ` });
  const second = saveEntry('u', { label: 'Exchange', family: 'evm', address: EVM_LOWER });
  assert.equal(first.label, 'Treasury');
  assert.equal(first.address, SOL_A);
  assert.equal(second.address, EVM_CHECKSUM, 'EVM addresses are stored checksummed');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)) && first.createdAt === first.updatedAt);
  const book = readAddressBook('u');
  assert.deepEqual(book.status === 'ok' && book.entries.map(entry => entry.label), ['Exchange', 'Treasury']);
});

test('validation copy: names, Solana, the system program, EVM zero and bad checksums', () => {
  assert.throws(() => cleanLabel('   '), { message: 'Enter a name.' });
  assert.throws(() => cleanLabel('x'.repeat(41)), { message: ADDRESS_BOOK_COPY.longName });
  assert.equal(cleanLabel('x'.repeat(40)), 'x'.repeat(40));
  assert.throws(() => cleanLabel('Line\nbreak'), { message: ADDRESS_BOOK_COPY.controlName });
  assert.throws(() => cleanLabel('Tre‮ysae'), { message: ADDRESS_BOOK_COPY.controlName });
  assert.throws(() => canonicalAddress('solana', 'not-an-address'), { message: 'Enter a valid Solana address.' });
  assert.throws(() => canonicalAddress('solana', ''), { message: 'Enter a valid Solana address.' });
  assert.throws(() => canonicalAddress('solana', EVM_LOWER), { message: 'Enter a valid Solana address.' });
  assert.throws(() => canonicalAddress('solana', '11111111111111111111111111111111'), { message: ADDRESS_BOOK_COPY.systemProgram });
  assert.throws(() => canonicalAddress('evm', `0x${'0'.repeat(40)}`), { message: 'Enter a valid, nonzero EVM address.' });
  assert.throws(() => canonicalAddress('evm', SOL_A), { message: 'Enter a valid, nonzero EVM address.' });
  // Mixed case with a wrong checksum is refused (strict, like transfers).
  assert.throws(() => canonicalAddress('evm', '0x52908400098527886E0F7030069857D2E4169Ee7'), { message: 'Enter a valid, nonzero EVM address.' });
  assert.equal(canonicalAddress('evm', EVM_CHECKSUM), EVM_CHECKSUM);
  assert.throws(() => saveEntry('u', { label: 'A', family: 'bitcoin' as never, address: SOL_A }), { message: ADDRESS_BOOK_COPY.noFamily });
  assert.equal(storage.writes, 0, 'refused input writes nothing');
});

test('duplicates (same family and address, any case) are refused with the saved label', () => {
  saveEntry('u', { label: 'Exchange', family: 'evm', address: EVM_CHECKSUM });
  assert.throws(() => saveEntry('u', { label: 'Other', family: 'evm', address: EVM_LOWER }), { message: 'This address is already saved as Exchange.' });
  saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  assert.throws(() => saveEntry('u', { label: 'Again', family: 'solana', address: SOL_A }), { message: 'This address is already saved as Treasury.' });
});

test('editing keeps the id and createdAt, may keep its own address, and cannot collide', () => {
  const entry = saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  saveEntry('u', { label: 'Cold', family: 'solana', address: SOL_B });
  const edited = saveEntry('u', { label: 'Treasury 2', family: 'solana', address: SOL_A }, entry.id);
  assert.equal(edited.id, entry.id);
  assert.equal(edited.createdAt, entry.createdAt);
  assert.equal(edited.label, 'Treasury 2');
  assert.throws(() => saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_B }, entry.id), { message: 'This address is already saved as Cold.' });
  assert.throws(() => saveEntry('u', { label: 'Ghost', family: 'solana', address: SOL_A }, 'missing-id'), { message: ADDRESS_BOOK_COPY.removed });
  const book = readAddressBook('u');
  assert.equal(book.status === 'ok' && book.entries.length, 2);
});

test('remove deletes one entry; the confirm copy names it', () => {
  const entry = saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  saveEntry('u', { label: 'Cold', family: 'solana', address: SOL_B });
  removeEntry('u', entry.id);
  const book = readAddressBook('u');
  assert.deepEqual(book.status === 'ok' && book.entries.map(item => item.label), ['Cold']);
  assert.equal(ADDRESS_BOOK_COPY.removeConfirm('Cold'), 'Remove Cold? This only removes it from this device.');
});

test('unreadable data is never overwritten: save and remove refuse, only an explicit reset clears it', () => {
  for (const corrupt of ['{not json', '[]', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ id: 'x', label: 'A', family: 'solana', address: 'bad', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' }] })]) {
    storage.values.set(ADDRESS_BOOK_KEY('u'), corrupt);
    storage.writes = 0;
    assert.deepEqual(readAddressBook('u'), { status: 'unreadable' }, corrupt);
    assert.throws(() => saveEntry('u', { label: 'A', family: 'solana', address: SOL_A }), { message: ADDRESS_BOOK_COPY.unreadable });
    assert.throws(() => removeEntry('u', 'x'), { message: ADDRESS_BOOK_COPY.unreadable });
    assert.equal(storage.values.get(ADDRESS_BOOK_KEY('u')), corrupt, 'the stored value is untouched');
    assert.equal(storage.writes, 0);
  }
  resetUnreadable('u');
  assert.deepEqual(readAddressBook('u'), { status: 'ok', entries: [] });
});

test('a readable book is never cleared by resetUnreadable', () => {
  saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  const before = storage.values.get(ADDRESS_BOOK_KEY('u'));
  resetUnreadable('u');
  assert.equal(storage.values.get(ADDRESS_BOOK_KEY('u')), before);
});

test('duplicate ids or addresses and non-canonical values make the stored book unreadable', () => {
  const entry = { id: 'a', label: 'A', family: 'evm', address: EVM_CHECKSUM, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' };
  for (const entries of [
    [entry, { ...entry, address: '0x2222222222222222222222222222222222222222' }],
    [entry, { ...entry, id: 'b', address: EVM_LOWER }],
    [{ ...entry, address: EVM_LOWER }],
    [{ ...entry, label: ' A ' }],
  ]) {
    storage.values.set(ADDRESS_BOOK_KEY('u'), JSON.stringify({ version: 1, entries }));
    assert.deepEqual(readAddressBook('u'), { status: 'unreadable' });
  }
});

test('storage that throws is unavailable, and saving reports it', () => {
  storage.blocked = true;
  assert.deepEqual(readAddressBook('u'), { status: 'unavailable' });
  assert.throws(() => saveEntry('u', { label: 'A', family: 'solana', address: SOL_A }), { message: ADDRESS_BOOK_COPY.unavailable });
});

test(`at most ${MAX_ENTRIES} entries`, () => {
  const entries = Array.from({ length: MAX_ENTRIES }, (_, index) => ({
    id: `id-${index}`, label: `Wallet ${index}`, family: 'evm',
    address: canonicalAddress('evm', `0x${(index + 1).toString(16).padStart(40, '0')}`),
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
  }));
  storage.values.set(ADDRESS_BOOK_KEY('u'), JSON.stringify({ version: 1, entries }));
  assert.equal(readAddressBook('u').status, 'ok');
  assert.throws(() => saveEntry('u', { label: 'One more', family: 'solana', address: SOL_A }), { message: ADDRESS_BOOK_COPY.full });
  // Editing stays possible at the limit.
  saveEntry('u', { label: 'Renamed', family: 'evm', address: entries[0].address }, 'id-0');
  storage.values.set(ADDRESS_BOOK_KEY('u'), JSON.stringify({ version: 1, entries: [...entries, { ...entries[0], id: 'extra', address: canonicalAddress('evm', `0x${'f'.repeat(40)}`) }] }));
  assert.deepEqual(readAddressBook('u'), { status: 'unreadable' });
});

test('every write dispatches solares:address-book; refused writes and reads do not', () => {
  const entry = saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  assert.equal(events, 1);
  saveEntry('u', { label: 'Treasury 2', family: 'solana', address: SOL_A }, entry.id);
  assert.equal(events, 2);
  assert.throws(() => saveEntry('u', { label: '', family: 'solana', address: SOL_B }));
  readAddressBook('u');
  assert.equal(events, 2);
  removeEntry('u', entry.id);
  assert.equal(events, 3);
  storage.values.set(ADDRESS_BOOK_KEY('u'), '{bad');
  resetUnreadable('u');
  assert.equal(events, 4);
});

test('recent recipients come from submitted or confirmed transfers, per family, newest first, unique, limited', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 13, 10, minutes)).toISOString();
  const records = [
    { id: '1', chain: 'solana', symbol: 'SOL', amount: '1', recipient: SOL_A, hash: 'h1', status: 'confirmed', createdAt: at(1) },
    { id: '2', chain: 'solana', symbol: 'USDC', amount: '1', recipient: SOL_B, hash: 'h2', status: 'submitted', createdAt: at(5) },
    { id: '3', chain: 'solana', symbol: 'SOL', amount: '1', recipient: SOL_A, hash: 'h3', status: 'confirmed', createdAt: at(3) },
    { id: '4', chain: 'solana', symbol: 'SOL', amount: '1', recipient: 'not-valid', hash: 'h4', status: 'confirmed', createdAt: at(9) },
    { id: '5', chain: 'base', symbol: 'USDC', amount: '1', recipient: EVM_LOWER, hash: 'h5', status: 'confirmed', createdAt: at(2) },
    { id: '6', chain: 'ethereum', symbol: 'ETH', amount: '1', recipient: EVM_CHECKSUM, hash: 'h6', status: 'confirmed', createdAt: at(4) },
    { id: '7', chain: 'bsc', symbol: 'BNB', amount: '1', recipient: '0x2222222222222222222222222222222222222222', hash: '', status: 'submission-unknown', createdAt: at(8) },
    { id: '8', chain: 'base', symbol: 'ETH', amount: '1', recipient: '0x3333333333333333333333333333333333333333', hash: 'h8', status: 'reverted', createdAt: at(7) },
    { id: '9', chain: 'arbitrum', symbol: 'USDC', amount: '1', recipient: '0x4444444444444444444444444444444444444444', hash: 'h9', status: 'confirmed', createdAt: at(6) },
  ];
  storage.values.set('solares:transfers:u', JSON.stringify(records));
  assert.deepEqual(recentRecipients('u', 'solana'), [SOL_B, SOL_A]);
  assert.deepEqual(recentRecipients('u', 'evm'), [EVM_CHECKSUM]);
  assert.deepEqual(recentRecipients('u', 'solana', 1), [SOL_B]);
  assert.deepEqual(recentRecipients('other-user', 'solana'), []);
});

test('the store makes no network calls', () => {
  saveEntry('u', { label: 'Treasury', family: 'solana', address: SOL_A });
  readAddressBook('u');
  recentRecipients('u', 'solana');
  assert.equal(fetches, 0);
});

test('families: Solana first, EVM names every supported EVM network, address equality per family', () => {
  assert.deepEqual(FAMILY_OPTIONS.map(option => option.label), ['Solana', 'EVM (Ethereum, BNB Smart Chain, Robinhood Chain, Base)']);
  assert.equal(familyOf('solana'), 'solana');
  assert.equal(familyOf('robinhood'), 'evm');
  assert.equal(sameAddress('evm', EVM_LOWER, EVM_CHECKSUM), true);
  assert.equal(sameAddress('solana', SOL_A, SOL_A.toLowerCase()), false);
});
