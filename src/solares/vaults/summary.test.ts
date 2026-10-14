import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VaultLayersLoad } from '../layers/gate';
import { parseVaultLayers } from '../layers/schema';
import { FIXTURE_MULTISIG, FIXTURE_RECIPIENT, emptyLayersFixture, layersFixture } from '../layers/testFixtures';
import type { PairedAccount, PairedGuardianConfig, PairedVaultRegistration } from './pairedApi';
import { antaraWalletProblem, summarizePairedVault, summaryChip, type PairedVaultDiscovery, type PairedVaultSummary, type SummaryInput } from './summary';

const OWNER = FIXTURE_RECIPIENT;
const GUARDIAN = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const DEPOSIT = '3YDvYJMo5EeZhgHctbqJzr3CaEM2ms25VFb6tTsZ8xAE';
const OTHER = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const config: PairedGuardianConfig = {
  guardian: GUARDIAN, cluster: 'mainnet-beta', policyVersion: 'antara-paired-solana-v1',
};
const account = (overrides: Partial<PairedAccount> = {}): PairedAccount => ({
  mfaEnrolled: true, wallets: [{ address: OWNER, embedded: true, pairProblem: null }], vaults: [], ...overrides,
});
const registration: PairedVaultRegistration = { multisig: FIXTURE_MULTISIG, vault: DEPOSIT, user: OWNER, guardian: GUARDIAN, createdAt: '2026-10-01T00:00:00.000Z' };
const verified = { address: FIXTURE_MULTISIG, depositAddress: DEPOSIT, user: OWNER, guardian: GUARDIAN };
const ready = (view = layersFixture()): VaultLayersLoad => ({ status: 'ready', view: parseVaultLayers(view, FIXTURE_MULTISIG), refreshing: false });
const discovered = (overrides: Partial<Extract<PairedVaultDiscovery, { status: 'ready' }>> = {}): PairedVaultDiscovery => ({
  status: 'ready', config, account: account({ vaults: [registration] }), registration, previous: null, vault: verified, ...overrides,
});
const input = (overrides: Partial<SummaryInput> = {}): SummaryInput => ({
  configured: true, authenticated: true, ready: true, owner: OWNER, pinned: true, discovery: discovered(), layers: ready(), pending: '', ...overrides,
});
const summarize = (overrides: Partial<SummaryInput> = {}) => summarizePairedVault(input(overrides));

test('signed out, unconfigured and loading claim nothing', () => {
  assert.deepEqual(summarize({ authenticated: false }), { state: 'signed-out' });
  assert.deepEqual(summarize({ configured: false }), { state: 'signed-out' });
  assert.deepEqual(summarize({ ready: false }), { state: 'loading' });
  assert.deepEqual(summarize({ discovery: { status: 'loading' } }), { state: 'loading' });
  assert.equal(summarize({ owner: null }).state, 'unavailable');
});

test('no pin and not provisioned map to their own states', () => {
  assert.deepEqual(summarize({ pinned: false }), { state: 'no-pin' });
  assert.deepEqual(summarize({ discovery: { status: 'no-pin' } }), { state: 'no-pin' });
  assert.deepEqual(summarize({ discovery: { status: 'not-provisioned' } }), { state: 'not-provisioned' });
});

test('a discovery failure is unavailable with its message, never a vault state', () => {
  assert.deepEqual(summarize({ discovery: { status: 'error', message: 'The vault service is unavailable. Nothing was changed.' } }),
    { state: 'unavailable', message: 'The vault service is unavailable. Nothing was changed.' });
});

test('never active without on-chain verification of exactly the registered vault', () => {
  for (const vault of [null, { ...verified, depositAddress: OTHER }, { ...verified, address: OTHER }, { ...verified, user: OTHER }, { ...verified, guardian: OTHER }]) {
    const summary = summarize({ discovery: discovered({ vault }) });
    assert.equal(summary.state, 'unavailable', JSON.stringify(vault));
  }
  // A registration for another user or guardian is not this wallet's vault.
  assert.equal(summarize({ discovery: discovered({ registration: { ...registration, guardian: OTHER } }) }).state, 'unavailable');
});

test('never active without a ready layer gate', () => {
  const checking = summarize({ layers: { status: 'loading' } });
  assert.equal(checking.state, 'registered');
  assert.equal((checking as Extract<PairedVaultSummary, { state: 'registered' }>).stage, 'checking');
  assert.equal(summarize({ layers: { status: 'idle' } }).state, 'registered');
  const unavailable = summarize({ layers: { status: 'unavailable', code: 'unavailable', message: 'Protection layers cannot be shown right now.' } });
  assert.deepEqual({ state: unavailable.state, stage: (unavailable as Extract<PairedVaultSummary, { state: 'registered' }>).stage }, { state: 'registered', stage: 'unavailable' });
});

test('activate-passkey maps to registered', () => {
  const summary = summarize({ layers: ready(emptyLayersFixture()) });
  assert.equal(summary.state, 'registered');
  const registered = summary as Extract<PairedVaultSummary, { state: 'registered' }>;
  assert.equal(registered.stage, 'activate-passkey');
  assert.equal(registered.multisig, FIXTURE_MULTISIG);
  assert.equal(registered.depositAddress, DEPOSIT);
});

test('a layer answer for another vault never counts', () => {
  const other = layersFixture();
  other.multisig = OTHER;
  const load: VaultLayersLoad = { status: 'ready', view: parseVaultLayers(other, OTHER), refreshing: false };
  const summary = summarize({ layers: load });
  assert.equal(summary.state, 'registered');
  assert.equal((summary as Extract<PairedVaultSummary, { state: 'registered' }>).stage, 'checking');
});

test('active only with verification and a ready gate; releaseBlock carries the existing pause reasons', () => {
  const summary = summarize();
  assert.equal(summary.state, 'active');
  const active = summary as Extract<PairedVaultSummary, { state: 'active' }>;
  assert.equal(active.multisig, FIXTURE_MULTISIG);
  assert.equal(active.depositAddress, DEPOSIT);
  assert.equal(active.gate.stage, 'ready');
  assert.equal(active.releaseBlock, '');
  // No account (Privy) MFA is required (2026-10-13): a stale `mfaEnrolled: false` never pauses releases.
  const noMfa = summarize({ discovery: discovered({ account: account({ mfaEnrolled: false, vaults: [registration] }) }) }) as Extract<PairedVaultSummary, { state: 'active' }>;
  assert.equal(noMfa.releaseBlock, '');
  const unlinked = summarize({ discovery: discovered({ account: account({ wallets: [], vaults: [registration] }) }) }) as Extract<PairedVaultSummary, { state: 'active' }>;
  assert.match(unlinked.releaseBlock, /no longer linked to your ANTARA account/);
  const problem = summarize({ discovery: discovered({ account: account({ wallets: [{ address: OWNER, embedded: false, pairProblem: 'This wallet is not your ANTARA wallet.' }], vaults: [registration] }) }) }) as Extract<PairedVaultSummary, { state: 'active' }>;
  assert.equal(problem.releaseBlock, 'Releases are paused: This wallet is not your ANTARA wallet.');
});

test('without a registration: previous, wallet, pending, activate (PairedSolanaVault order); account MFA is never asked for', () => {
  const none = (overrides: Partial<Extract<PairedVaultDiscovery, { status: 'ready' }>> = {}) => discovered({ registration: null, vault: null, account: account(), ...overrides });
  assert.deepEqual(summarize({ discovery: none({ previous: { ...registration, guardian: OTHER } }) }), { state: 'not-activated', reason: 'previous' });
  assert.deepEqual(summarize({ discovery: none({ account: account({ wallets: [] }) }) }), { state: 'not-activated', reason: 'wallet' });
  assert.deepEqual(summarize({ discovery: none({ account: account({ wallets: [{ address: OWNER, embedded: false, pairProblem: 'Not your ANTARA wallet.' }] }) }) }), { state: 'not-activated', reason: 'wallet' });
  // The ANTARA (embedded) wallet itself that the server will not pair carries the server's reason.
  const delegated = 'Your ANTARA wallet allows delegated (server) signing. Revoke it before using a paired vault, because a server could then sign as you.';
  assert.deepEqual(summarize({ discovery: none({ account: account({ wallets: [{ address: OWNER, embedded: true, pairProblem: delegated }] }) }) }), { state: 'not-activated', reason: 'wallet', problem: delegated });
  assert.equal(antaraWalletProblem({ embedded: true, pairProblem: delegated }), delegated);
  assert.equal(antaraWalletProblem({ embedded: false, pairProblem: 'Not your ANTARA wallet.' }), null);
  assert.equal(antaraWalletProblem({ embedded: true, pairProblem: null }), null);
  assert.equal(antaraWalletProblem(null), null);
  assert.equal(summaryChip({ state: 'not-activated', reason: 'wallet', problem: delegated }).label, 'Not available for this wallet');
  assert.equal(summaryChip({ state: 'not-activated', reason: 'wallet' }).label, 'Use your ANTARA wallet for the vault');
  assert.deepEqual(summarize({ discovery: none({ account: account({ mfaEnrolled: false }) }) }), { state: 'not-activated', reason: 'activate' });
  assert.deepEqual(summarize({ discovery: none(), pending: FIXTURE_MULTISIG }), { state: 'not-activated', reason: 'pending' });
  assert.deepEqual(summarize({ discovery: none() }), { state: 'not-activated', reason: 'activate' });
});

test('the chip says "Active" only for an active summary', () => {
  const states: PairedVaultSummary[] = [
    { state: 'signed-out' }, { state: 'loading' }, { state: 'no-pin' }, { state: 'not-provisioned' }, { state: 'unavailable', message: 'x' },
    ...(['activate', 'pending', 'mfa', 'wallet', 'previous'] as const).map(reason => ({ state: 'not-activated' as const, reason })),
    ...(['checking', 'unavailable', 'activate-passkey'] as const).map(stage => ({ state: 'registered' as const, stage, multisig: FIXTURE_MULTISIG, depositAddress: DEPOSIT, layers: { status: 'loading' } as VaultLayersLoad })),
  ];
  for (const summary of states) assert.doesNotMatch(summaryChip(summary).label, /Active/, summary.state);
  assert.equal(summaryChip(summarize()).label, `Active · ${FIXTURE_MULTISIG.slice(0, 6)}…${FIXTURE_MULTISIG.slice(-5)}`);
  assert.equal(summaryChip(summarize({ discovery: discovered({ account: account({ wallets: [], vaults: [registration] }) }) })).label, 'Active · releases paused');
  assert.equal(summaryChip({ state: 'registered', stage: 'activate-passkey', multisig: FIXTURE_MULTISIG, depositAddress: DEPOSIT, layers: { status: 'loading' } }).label, 'Add a passkey to finish');
});
