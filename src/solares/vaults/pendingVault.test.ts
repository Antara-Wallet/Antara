import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SOLANA_GENESIS } from '../wallet/solanaNetwork';
import { newWallet, pairedKeys } from '../paired/testFixtures';
import { parsePairedAccount, type PairedAccount, type PairedGuardianConfig } from './pairedApi';
import {
  PENDING_EXISTS_NOTE, PENDING_UNKNOWN_NOTE, pendingDiscard, readPendingAccountState, resumablePairedVault, type PendingAccountReader, type ResumableVault,
} from './pendingVault';
import { summarizePairedVault, type SummaryInput } from './summary';

const keys = pairedKeys();
const found = { multisig: keys.multisig, vault: keys.vault, user: keys.user, guardian: keys.guardian };
const wire = (extra: Record<string, unknown> = {}) => ({ mfaEnrolled: true, wallets: [{ address: keys.user, embedded: true, pairProblem: null }], vaults: [], ...extra });

describe('unregistered vaults in GET /solana/account', () => {
  it('parses them strictly, deriving the deposit address, and leaves the field out for an older server', () => {
    assert.deepEqual(parsePairedAccount(wire({ unregistered: [{ ...found, extra: 'ignored' }] })).unregistered, [found]);
    assert.deepEqual(parsePairedAccount(wire({ unregistered: [] })).unregistered, []);
    assert.equal('unregistered' in parsePairedAccount(wire()), false, 'absent: nothing is known either way');
    for (const bad of [
      { unregistered: [{ ...found, vault: newWallet() }] },
      { unregistered: [{ ...found, user: 'not an address' }] },
      { unregistered: {} },
      { unregistered: Array.from({ length: 11 }, () => found) },
    ]) assert.throws(() => parsePairedAccount(wire(bad)), /unexpected response/);
  });

  it('resumes this device’s key first, else the vault found on Solana for this wallet and guardian', () => {
    const account: Pick<PairedAccount, 'unregistered'> = { unregistered: [found] };
    assert.deepEqual(resumablePairedVault('', account, keys.user, keys.guardian), { multisig: keys.multisig, source: 'chain' });
    const local = pairedKeys().multisig;
    assert.deepEqual(resumablePairedVault(local, account, keys.user, keys.guardian), { multisig: local, source: 'device' });
    assert.equal(resumablePairedVault('', account, newWallet(), keys.guardian), null, 'another wallet');
    assert.equal(resumablePairedVault('', account, keys.user, newWallet()), null, 'another guardian');
    assert.equal(resumablePairedVault('', {}, keys.user, keys.guardian), null);
    assert.equal(resumablePairedVault('', null, keys.user, keys.guardian), null);
  });

  it('makes the home summary say "pending" instead of offering a second vault', () => {
    const config: PairedGuardianConfig = { guardian: keys.guardian, cluster: 'mainnet-beta', policyVersion: 'antara-paired-solana-v1' };
    const input = (account: PairedAccount, pending = ''): SummaryInput => ({
      configured: true, authenticated: true, ready: true, owner: keys.user, pinned: true, layers: { status: 'idle' }, pending,
      discovery: { status: 'ready', config, account, registration: null, previous: null, vault: null },
    });
    assert.deepEqual(summarizePairedVault(input(parsePairedAccount(wire({ unregistered: [found] })))), { state: 'not-activated', reason: 'pending' });
    assert.deepEqual(summarizePairedVault(input(parsePairedAccount(wire({ unregistered: [] })))), { state: 'not-activated', reason: 'activate' });
    assert.deepEqual(summarizePairedVault(input(parsePairedAccount(wire()), keys.multisig)), { state: 'not-activated', reason: 'pending' });
  });
});

describe('discarding a pending creation', () => {
  const device: ResumableVault = { multisig: keys.multisig, source: 'device' };
  const chain = (state: 'checking' | 'missing' | 'exists' | 'unknown', multisig = keys.multisig) => ({ multisig, state });
  it('is offered only for this device’s key while Solana reports no account there', () => {
    assert.deepEqual(pendingDiscard(device, chain('missing')), { discardable: true, note: '' });
    assert.deepEqual(pendingDiscard(device, chain('exists')), { discardable: false, note: PENDING_EXISTS_NOTE });
    assert.deepEqual(pendingDiscard(device, chain('unknown')), { discardable: false, note: PENDING_UNKNOWN_NOTE });
    assert.deepEqual(pendingDiscard(device, chain('checking')), { discardable: false, note: '' });
    assert.deepEqual(pendingDiscard(device, null), { discardable: false, note: '' });
    // An answer about another address says nothing about this one.
    assert.deepEqual(pendingDiscard(device, chain('missing', pairedKeys().multisig)), { discardable: false, note: '' });
    // A vault the server found on Solana is never discarded, whatever this client last read.
    for (const state of ['missing', 'exists', 'unknown', 'checking'] as const) {
      assert.deepEqual(pendingDiscard({ multisig: keys.multisig, source: 'chain' }, chain(state)), { discardable: false, note: PENDING_EXISTS_NOTE });
    }
    assert.deepEqual(pendingDiscard(null, chain('missing')), { discardable: false, note: '' });
  });

  it('reads the account on the expected cluster only', async () => {
    const reader = (genesis: string, exists: boolean): PendingAccountReader & { reads: string[] } => {
      const reads: string[] = [];
      return { reads, getGenesisHash: async () => genesis, accountExists: async address => { reads.push(address); return exists; } };
    };
    assert.equal(await readPendingAccountState(keys.multisig, reader(SOLANA_GENESIS['mainnet-beta'], false), 'mainnet-beta'), 'missing');
    const existing = reader(SOLANA_GENESIS['mainnet-beta'], true);
    assert.equal(await readPendingAccountState(keys.multisig, existing, 'mainnet-beta'), 'exists');
    assert.deepEqual(existing.reads, [keys.multisig]);
    // An RPC on another cluster would report "missing" for a real vault: refused, so nothing is discarded.
    const wrong = reader(SOLANA_GENESIS.devnet, false);
    await assert.rejects(readPendingAccountState(keys.multisig, wrong, 'mainnet-beta'), /not on mainnet-beta/);
    assert.deepEqual(wrong.reads, []);
  });
});
