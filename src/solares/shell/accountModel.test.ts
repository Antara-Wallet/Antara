import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedVaultStatus, networkAfterSelect, pillModel, signerLabel, vaultHost, vaultRowStatus } from './accountModel';
import type { PairedVaultSummary } from './screens';

const MULTISIG = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';
const loadingLayers = { status: 'loading' } as const;
const gate = { stage: 'ready', releaseBlock: '', depositBlock: '', firstPasskeyAt: null } as const;

test('the Vault row says Active only for an active summary', () => {
  const states: PairedVaultSummary[] = [
    { state: 'loading' }, { state: 'no-pin' }, { state: 'not-provisioned' }, { state: 'unavailable', message: 'x' },
    { state: 'not-activated', reason: 'activate' }, { state: 'not-activated', reason: 'wallet' },
    { state: 'registered', stage: 'checking', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers },
    { state: 'registered', stage: 'unavailable', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers },
    { state: 'registered', stage: 'activate-passkey', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers },
  ];
  for (const summary of states) {
    const status = vaultRowStatus(summary)!;
    assert.doesNotMatch(status.label, /active/i, summary.state);
    assert.notEqual(status.tone, 'ok', summary.state);
  }
  assert.equal(vaultRowStatus({ state: 'signed-out' }), null);
});

test('each summary state maps to the 6.3 copy', () => {
  assert.deepEqual(vaultRowStatus({ state: 'loading' }), { tone: 'neutral', label: 'Checking…' });
  assert.equal(vaultRowStatus({ state: 'no-pin' })!.label, 'Not available');
  assert.equal(vaultRowStatus({ state: 'not-provisioned' })!.label, 'Not available');
  assert.equal(vaultRowStatus({ state: 'unavailable', message: 'Down' })!.label, 'Status unavailable');
  assert.equal(vaultRowStatus({ state: 'not-activated', reason: 'mfa' })!.label, 'Not activated');
  assert.equal(vaultRowStatus({ state: 'not-activated', reason: 'wallet' })!.label, 'Use your ANTARA wallet for the vault');
  // The ANTARA wallet the server will not pair is never told to use the ANTARA wallet.
  assert.equal(vaultRowStatus({ state: 'not-activated', reason: 'wallet', problem: 'Delegated signing is on.' })!.label, 'Not available for this wallet');
  assert.deepEqual(hostedVaultStatus({ state: 'not-activated', reason: 'wallet', problem: 'Delegated signing is on.' }, true), { tone: 'neutral', label: 'Not available for this wallet' });
  assert.equal(vaultRowStatus({ state: 'registered', stage: 'activate-passkey', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers })!.label, 'Add a passkey to finish');
  assert.equal(vaultRowStatus({ state: 'registered', stage: 'checking', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers })!.label, 'Checking…');
  assert.equal(vaultRowStatus({ state: 'registered', stage: 'unavailable', multisig: MULTISIG, depositAddress: MULTISIG, layers: loadingLayers })!.label, 'Status unavailable');
  assert.deepEqual(vaultRowStatus({ state: 'active', multisig: MULTISIG, depositAddress: MULTISIG, gate, layers: loadingLayers, releaseBlock: '' }), { tone: 'ok', label: 'Active · GyGKxM…GUdse' });
  assert.deepEqual(vaultRowStatus({ state: 'active', multisig: MULTISIG, depositAddress: MULTISIG, gate, layers: loadingLayers, releaseBlock: 'Add an authenticator app.' }), { tone: 'warn', label: 'Active · releases paused' });
});

test('the pill keeps its asserted accessible names and never shows an address it does not have', () => {
  assert.deepEqual(pillModel({ authenticated: false, configured: true, address: null, name: null, solanaView: true }), { ariaLabel: 'Sign in to ANTARA', title: 'Sign in', subtitle: 'Your ANTARA wallet', logo: 'solana' });
  const signedIn = pillModel({ authenticated: true, configured: true, address: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9', name: 'Solana wallet', solanaView: true });
  assert.deepEqual(signedIn, { ariaLabel: 'Select wallet', title: 'Solana wallet', subtitle: 'AKnL4N…aRSZ9', logo: 'solana' });
  assert.equal(pillModel({ authenticated: true, configured: true, address: null, name: null, solanaView: false }).subtitle, 'Wallet loading…');
  assert.equal(pillModel({ authenticated: true, configured: true, address: null, name: null, solanaView: false }).title, 'EVM wallet');
});

test('choosing a wallet keeps a selected EVM network, else its family default', () => {
  assert.equal(networkAfterSelect('solana', 'bsc'), 'solana');
  assert.equal(networkAfterSelect('evm', 'bsc'), 'bsc');
  assert.equal(networkAfterSelect('evm', 'solana'), 'ethereum');
  assert.equal(networkAfterSelect('evm', 'all'), 'ethereum');
});

test('the Vault row sits only under the ANTARA Solana wallet and shows its summary only while it is selected', () => {
  const antara = { address: 'Cu73KkPjfrA4xVZiZWRdM1JZVVDu5U9t4zU3oKMxsAvf', name: 'ANTARA wallet', embedded: true };
  const phantom = { address: 'EMX22GqsGJbZAMr3uE6g6yZ7EjZz8Y1tMRu2CnZny5tD', name: 'Phantom', embedded: false };
  const second = { address: 'Second1111111111111111111111111111111111111', name: 'ANTARA wallet', embedded: true };
  assert.equal(vaultHost([phantom, antara], phantom.address), antara);
  assert.equal(vaultHost([phantom, antara, second], second.address), second);
  assert.equal(vaultHost([phantom, antara, second], null), antara);
  assert.equal(vaultHost([phantom, { address: 'X', name: 'Solana wallet' }], phantom.address), null);
  assert.equal(hostedVaultStatus({ state: 'signed-out' }, true), null);
  assert.deepEqual(hostedVaultStatus({ state: 'loading' }, false), { tone: 'neutral', label: 'Select to view' });
  assert.deepEqual(hostedVaultStatus({ state: 'not-activated', reason: 'wallet' }, false), { tone: 'neutral', label: 'Select to view' });
  // Under the ANTARA wallet itself, never "Use your ANTARA wallet for the vault".
  assert.deepEqual(hostedVaultStatus({ state: 'not-activated', reason: 'wallet' }, true), { tone: 'neutral', label: 'Not available for this wallet' });
  assert.deepEqual(hostedVaultStatus({ state: 'not-activated', reason: 'activate' }, true), vaultRowStatus({ state: 'not-activated', reason: 'activate' }));
  assert.deepEqual(hostedVaultStatus({ state: 'no-pin' }, true), { tone: 'neutral', label: 'Not available' });
});

test('the pill names the embedded wallet ANTARA wallet, never Privy', () => {
  const solana = [{ address: 'Cu73Kk', name: 'Privy', embedded: true }, { address: 'EMX22G', name: 'Phantom' }];
  assert.equal(signerLabel(solana, 'Cu73Kk', 'solana'), 'ANTARA wallet');
  assert.equal(signerLabel(solana, 'EMX22G', 'solana'), 'Phantom');
  assert.equal(signerLabel([{ address: '0x7E6c', name: 'privy', embedded: true }], '0x7E6c', 'evm'), 'ANTARA wallet');
  assert.equal(signerLabel(solana, 'missing', 'solana'), null);
  assert.equal(signerLabel(solana, null, 'solana'), null);
});
