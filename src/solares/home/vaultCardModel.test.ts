import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_STEPS, vaultCardModel } from './vaultCardModel';
import type { PairedVaultSummary } from '../vaults/summary';
import type { LayerGate, VaultLayersLoad } from '../layers/gate';

const LAYERS = { status: 'loading' } as VaultLayersLoad;
const GATE = { stage: 'ready', releaseBlock: '' } as unknown as LayerGate;
const base = { multisig: 'M'.repeat(44), depositAddress: 'D'.repeat(44), layers: LAYERS };

test('a wallet without a vault gets one obvious primary action: Create your vault', () => {
  const model = vaultCardModel({ state: 'not-activated', reason: 'activate' });
  // The button hands off to the Vault side's create sequence (vaults/vaultIntent.ts).
  assert.deepEqual(model.action, { label: 'Create your vault', primary: true, intent: 'create' });
  assert.equal(model.chip, 'Not created');
  assert.equal(model.step, null);
  assert.match(model.text, /2-of-2/);
});

test('activation shows progress at the real step: a started creation, then the first passkey', () => {
  const pending = vaultCardModel({ state: 'not-activated', reason: 'pending' });
  assert.equal(pending.step, 0);
  assert.equal(pending.chip, 'Activating');
  assert.deepEqual(pending.action, { label: 'Finish activation', primary: true, intent: 'create' });
  const passkey = vaultCardModel({ state: 'registered', stage: 'activate-passkey', ...base });
  assert.equal(passkey.step, 2);
  assert.equal(VAULT_STEPS[passkey.step], 'Add a passkey');
  assert.deepEqual(passkey.action, { label: 'Add a passkey', primary: true, intent: 'passkey' });
});

test('"Active" appears only for an active vault; paused releases say so', () => {
  const states: PairedVaultSummary[] = [
    { state: 'signed-out' }, { state: 'loading' }, { state: 'no-pin' }, { state: 'not-provisioned' },
    { state: 'unavailable', message: 'Your vault could not be checked. Please try again.' },
    { state: 'not-activated', reason: 'activate' }, { state: 'not-activated', reason: 'pending' },
    { state: 'not-activated', reason: 'wallet' }, { state: 'not-activated', reason: 'previous' }, { state: 'not-activated', reason: 'mfa' },
    { state: 'registered', stage: 'checking', ...base }, { state: 'registered', stage: 'unavailable', ...base },
    { state: 'registered', stage: 'activate-passkey', ...base },
  ];
  for (const summary of states) {
    const model = vaultCardModel(summary);
    assert.notEqual(model.tone, 'ok', summary.state);
    assert.doesNotMatch(model.chip, /Active/, summary.state);
  }
  const active = vaultCardModel({ state: 'active', gate: GATE, releaseBlock: '', ...base });
  assert.equal(active.tone, 'ok');
  assert.equal(active.chip, 'Active');
  assert.deepEqual(active.action, { label: 'Open vault', primary: false });
  const paused = vaultCardModel({ state: 'active', gate: GATE, releaseBlock: 'Releases are paused: test reason', ...base });
  assert.equal(paused.chip, 'Releases paused');
  assert.equal(paused.text, 'Releases are paused: test reason');
});

test('the ANTARA wallet the server will not pair says why instead of asking to select it', () => {
  const other = vaultCardModel({ state: 'not-activated', reason: 'wallet' });
  assert.match(other.text, /Select it in the account menu/);
  const refused = vaultCardModel({ state: 'not-activated', reason: 'wallet', problem: 'Your ANTARA wallet allows delegated (server) signing.' });
  assert.equal(refused.chip, 'Not available');
  assert.equal(refused.text, 'ANTARA can’t pair a vault with this wallet. Your ANTARA wallet allows delegated (server) signing.');
  assert.doesNotMatch(refused.text, /Select it/);
  assert.deepEqual(refused.action, { label: 'Open vault', primary: false });
  assert.notEqual(refused.action?.intent, 'create');
});

test('unavailable states give a short honest reason, no create action, and Retry where it can help', () => {
  for (const state of ['no-pin', 'not-provisioned'] as const) {
    const model = vaultCardModel({ state });
    assert.equal(model.action, null, state);
    assert.equal(model.chip, 'Not available', state);
  }
  const failed = vaultCardModel({ state: 'unavailable', message: 'Sign in again to check your vault.' });
  assert.equal(failed.text, 'Sign in again to check your vault.');
  assert.equal(failed.retry, true);
  assert.notEqual(failed.action?.label, 'Create your vault');
});

test('vault card copy never uses a dash placeholder', () => {
  const all: PairedVaultSummary[] = [
    { state: 'signed-out' }, { state: 'loading' }, { state: 'no-pin' }, { state: 'not-provisioned' },
    { state: 'not-activated', reason: 'activate' }, { state: 'registered', stage: 'checking', ...base },
    { state: 'active', gate: GATE, releaseBlock: '', ...base },
  ];
  for (const summary of all) {
    const model = vaultCardModel(summary);
    assert.doesNotMatch(`${model.chip} ${model.text} ${model.action?.label ?? ''}`, /—/);
  }
});
