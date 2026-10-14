import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { VAULT_ACTIVITY_EVENT, VAULT_ACTIVITY_KEY, parseVaultActivityRecord, recordVaultActivity, vaultActivity, type VaultActivityRecord } from './vaultActivity';

class MemoryStorage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('QuotaExceededError'); this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const storage = new MemoryStorage();
const events: CustomEvent[] = [];
const target = new EventTarget();
target.addEventListener(VAULT_ACTIVITY_EVENT, event => events.push(event as CustomEvent));
Object.assign(globalThis, { localStorage: storage, window: target });

const MULTISIG = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ';
const RECIPIENT = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const SIGNATURE = '5'.repeat(88);
const deposit = (id: string, createdAt: string, overrides: Partial<VaultActivityRecord> = {}): VaultActivityRecord => ({
  id, kind: 'deposit', multisig: MULTISIG, asset: 'SOL', amount: '0.5', signature: SIGNATURE, status: 'confirmed', createdAt, ...overrides,
});
const release: VaultActivityRecord = {
  id: 'release-12', kind: 'release', multisig: MULTISIG, asset: 'USDC', amount: '25', recipient: RECIPIENT, index: '12', signature: SIGNATURE, status: 'submitted', createdAt: '2026-10-13T09:00:00.000Z',
};

beforeEach(() => { storage.values.clear(); storage.failWrites = false; events.length = 0; });

test('empty for a user with nothing stored, and for no user', () => {
  assert.deepEqual(vaultActivity('user-a'), []);
  assert.deepEqual(vaultActivity(''), []);
});

test('records read back newest first; the same id replaces the earlier record', () => {
  recordVaultActivity('user-a', deposit('deposit-1', '2026-10-12T08:00:00.000Z'));
  recordVaultActivity('user-a', release);
  recordVaultActivity('user-a', { ...release, status: 'confirmed' });
  const records = vaultActivity('user-a');
  assert.deepEqual(records.map(item => item.id), ['release-12', 'deposit-1']);
  assert.equal(records[0].status, 'confirmed');
  assert.deepEqual(records[0], { ...release, status: 'confirmed' });
});

test('each write dispatches solares:vault-activity for that user', () => {
  recordVaultActivity('user-a', release);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail, { privyUserId: 'user-a', id: 'release-12' });
});

test('records are per user', () => {
  recordVaultActivity('user-a', release);
  assert.equal(vaultActivity('user-a').length, 1);
  assert.deepEqual(vaultActivity('user-b'), []);
  assert.ok(storage.values.has(VAULT_ACTIVITY_KEY('user-a')));
});

test('malformed rows are dropped on read', () => {
  const rows = [
    release,
    { ...release, id: 'bad-kind', kind: 'swap' },
    { ...release, id: 'bad-signature', signature: 'not a signature' },
    { ...release, id: 'extra-field', note: 'hello' },
    { ...release, id: 'no-recipient', recipient: undefined },
    { ...release, id: 'bad-amount', amount: '-1' },
    { ...deposit('bad-date', 'yesterday') },
    { ...deposit('bad-multisig', '2026-10-12T08:00:00.000Z', { multisig: '0xabc' }) },
    'not an object',
    null,
    deposit('deposit-ok', '2026-10-11T08:00:00.000Z'),
    { ...release },
  ].map(row => (row && typeof row === 'object' ? JSON.parse(JSON.stringify(row)) : row));
  storage.values.set(VAULT_ACTIVITY_KEY('user-a'), JSON.stringify(rows));
  assert.deepEqual(vaultActivity('user-a').map(item => item.id), ['release-12', 'deposit-ok']);
  assert.ok(parseVaultActivityRecord({ id: 'activation-1', kind: 'activation', multisig: MULTISIG, signature: SIGNATURE, status: 'confirmed', createdAt: '2026-10-10T00:00:00.000Z' }));
});

test('unreadable storage reads as empty and is never overwritten', () => {
  storage.values.set(VAULT_ACTIVITY_KEY('user-a'), '{not json');
  assert.deepEqual(vaultActivity('user-a'), []);
  recordVaultActivity('user-a', release);
  assert.equal(storage.values.get(VAULT_ACTIVITY_KEY('user-a')), '{not json');
  assert.equal(events.length, 0);
});

test('a malformed record is refused; a failed write is ignored without an event', () => {
  assert.throws(() => recordVaultActivity('user-a', { ...release, signature: 'x' }), /malformed/);
  assert.throws(() => recordVaultActivity('', release), /Sign in/);
  storage.failWrites = true;
  recordVaultActivity('user-a', release);
  assert.deepEqual(vaultActivity('user-a'), []);
  assert.equal(events.length, 0);
});

test('at most 100 records, newest kept', () => {
  for (let index = 0; index < 105; index++) {
    recordVaultActivity('user-a', deposit(`deposit-${index}`, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()));
  }
  const records = vaultActivity('user-a');
  assert.equal(records.length, 100);
  assert.equal(records[0].id, 'deposit-104');
  assert.equal(records[99].id, 'deposit-5');
});
