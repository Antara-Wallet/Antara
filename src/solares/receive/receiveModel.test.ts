import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressHeading, assetRows, copiedMessage, filterRows, networkNote, receiveHeading, stablecoinLine, vaultRows, walletAddressFor,
} from './receiveModel';
import { VAULT_STATE_TITLES, vaultAddresses, vaultReceiveState, type VaultSummaryInput } from './vaultTarget';
import type { VaultLayersLoad } from '../layers/gate';

test('ten rows in registry order, native then stablecoin, Solana first', () => {
  const rows = assetRows('mainnet-beta');
  assert.deepEqual(rows.map(row => `${row.label} · ${row.network}`), [
    'SOL · Solana', 'USDC · Solana',
    'ETH · Ethereum', 'USDC · Ethereum',
    'BNB · BNB Smart Chain', 'USDC (Binance-Peg) · BNB Smart Chain',
    'ETH · Robinhood Chain', 'USDG · Robinhood Chain',
    'ETH · Base', 'USDC · Base',
  ]);
  assert.ok(rows.every(row => !row.unavailable));
  assert.deepEqual(rows.map(row => row.family), ['solana', 'solana', 'evm', 'evm', 'evm', 'evm', 'evm', 'evm', 'evm', 'evm']);
});

test('stablecoin identity is exact: Binance-Peg USDC and USDG are never plain USDC and never use the USDC mark', () => {
  const rows = assetRows('mainnet-beta');
  const bsc = rows.find(row => row.key === 'bsc:stablecoin')!;
  const robinhood = rows.find(row => row.key === 'robinhood:stablecoin')!;
  assert.equal(bsc.label, 'USDC (Binance-Peg)');
  assert.equal(bsc.decimals, 18);
  assert.equal(bsc.mark, 'stablecoin');
  assert.match(bsc.issuerNote, /not by Circle/);
  assert.equal(robinhood.label, 'USDG');
  assert.equal(robinhood.mark, 'stablecoin');
  assert.doesNotMatch(`${robinhood.label} ${robinhood.name}`, /USDC/);
  assert.equal(rows.find(row => row.key === 'solana:stablecoin')!.mark, 'USDC');
  assert.equal(rows.find(row => row.key === 'base:stablecoin')!.issuerNote, '');
});

test('devnet disables Solana USDC ("Mainnet only") and labels the network', () => {
  const rows = assetRows('devnet');
  assert.equal(rows.length, 10);
  assert.equal(rows[0].network, 'Solana devnet');
  assert.equal(rows[1].unavailable, 'Mainnet only');
  assert.ok(rows.slice(2).every(row => !row.unavailable));
  assert.deepEqual(vaultRows('devnet').map(row => row.label), ['SOL']);
  assert.deepEqual(vaultRows('mainnet-beta').map(row => row.label), ['SOL', 'USDC']);
  assert.equal(stablecoinLine('solana', 'devnet'), '');
  assert.equal(networkNote('solana', 'devnet'), 'Only send devnet assets on Solana devnet to this address. Verify the network in the sending wallet.');
});

test('search matches assets or networks by every word and keeps registry order', () => {
  const rows = assetRows('mainnet-beta');
  assert.deepEqual(filterRows(rows, 'usdc').map(row => row.key), ['solana:stablecoin', 'ethereum:stablecoin', 'bsc:stablecoin', 'base:stablecoin']);
  assert.deepEqual(filterRows(rows, 'base').map(row => row.key), ['base:native', 'base:stablecoin']);
  assert.deepEqual(filterRows(rows, 'eth robinhood').map(row => row.key), ['robinhood:native']);
  assert.deepEqual(filterRows(rows, 'bsc').map(row => row.key), ['bsc:native', 'bsc:stablecoin']);
  assert.deepEqual(filterRows(rows, 'paxos').map(row => row.key), ['robinhood:stablecoin']);
  assert.equal(filterRows(rows, '   ').length, 10);
  assert.equal(filterRows(rows, 'dogecoin').length, 0);
});

test('addresses: Solana rows use the Solana wallet, every EVM row the one EVM wallet', () => {
  const addresses = { solana: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9', ethereum: '0x1111111111111111111111111111111111111111' };
  assert.equal(walletAddressFor('solana', addresses), addresses.solana);
  assert.equal(walletAddressFor('evm', addresses), addresses.ethereum);
  assert.equal(walletAddressFor('solana', { solana: null, ethereum: addresses.ethereum }), null);
});

test('copy: headings, notes and the existing stablecoin lines', () => {
  const [sol, usdc] = assetRows('mainnet-beta');
  assert.equal(receiveHeading(usdc), 'Receive USDC on Solana');
  assert.equal(addressHeading(sol, 'wallet'), 'Your Solana address');
  assert.equal(addressHeading(sol, 'vault'), 'Your vault’s deposit address');
  assert.equal(copiedMessage(sol, 'wallet'), 'Solana address copied.');
  assert.equal(networkNote('base', 'mainnet-beta'), 'Only send assets on Base to this address. Verify the network in the sending wallet.');
  assert.equal(stablecoinLine('robinhood', 'mainnet-beta').startsWith('Stablecoin on Robinhood Chain: USDG (Paxos Global Dollar).'), true);
  assert.match(stablecoinLine('bsc', 'mainnet-beta'), /^Stablecoin on BNB Smart Chain: USDC \(Binance-Peg\) \(Binance-Peg USD Coin\)\. .*not by Circle/);
  assert.equal(stablecoinLine('ethereum', 'mainnet-beta'), 'Stablecoin on Ethereum: USDC (USD Coin).');
});

const MULTISIG = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ';
const DEPOSIT = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const unavailable: VaultLayersLoad = { status: 'unavailable', code: 'server', message: 'Try again shortly.' };
const readyGate = { stage: 'ready' as const, releaseBlock: '', depositBlock: '', firstPasskeyAt: null };

test('vault Receive shows the deposit address only for an active vault with no deposit block', () => {
  const active: VaultSummaryInput = { state: 'active', multisig: MULTISIG, depositAddress: DEPOSIT, gate: readyGate, layers: { status: 'loading' }, releaseBlock: '' };
  assert.deepEqual(vaultReceiveState(active), { kind: 'ready', address: DEPOSIT, multisig: MULTISIG });
  const paused = { ...active, gate: { ...readyGate, depositBlock: 'Deposits are paused.' } } as VaultSummaryInput;
  assert.deepEqual(vaultReceiveState(paused), { kind: 'blocked', title: VAULT_STATE_TITLES.checking, reason: 'Deposits are paused.' });
});

test('every non-active vault state shows a reason and no address', () => {
  const registered: VaultSummaryInput = { state: 'registered', stage: 'unavailable', multisig: MULTISIG, depositAddress: DEPOSIT, layers: unavailable };
  const blocked = vaultReceiveState(registered);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.kind === 'blocked' && blocked.title, 'We couldn’t check your vault’s protection');
  assert.match(blocked.kind === 'blocked' ? blocked.reason : '', /deposits and releases are paused here/);
  const states: [VaultSummaryInput | null, string][] = [
    [null, 'Finding your vault'],
    [{ state: 'loading' }, 'Finding your vault'],
    [{ state: 'signed-out' }, 'Your wallet. Its own vault.'],
    [{ state: 'no-pin' }, 'Vault protection isn’t available in this build'],
    [{ state: 'not-provisioned' }, 'Vault protection isn’t switched on yet'],
    [{ state: 'unavailable', message: 'Network error.' }, 'We couldn’t check your vault'],
    [{ state: 'not-activated', reason: 'activate' }, 'Activate your Solana vault'],
    [{ state: 'not-activated', reason: 'mfa' }, 'Add an authenticator app first'],
    [{ state: 'not-activated', reason: 'wallet' }, 'Use your ANTARA wallet for the vault'],
    [{ state: 'not-activated', reason: 'pending' }, 'Finish activating your vault'],
    [{ state: 'not-activated', reason: 'previous' }, 'Your vault uses a previous ANTARA guardian'],
  ];
  for (const [summary, title] of states) {
    const state = vaultReceiveState(summary);
    assert.equal(state.kind, 'blocked');
    assert.equal(state.kind === 'blocked' && state.title, title);
    assert.ok(!JSON.stringify(state).includes(DEPOSIT));
  }
});

test('vault addresses are known once registered; only an active vault is listed as yours', () => {
  assert.equal(vaultAddresses(null), null);
  assert.equal(vaultAddresses({ state: 'not-activated', reason: 'activate' }), null);
  assert.deepEqual(vaultAddresses({ state: 'registered', stage: 'activate-passkey', multisig: MULTISIG, depositAddress: DEPOSIT, layers: unavailable }), { depositAddress: DEPOSIT, multisig: MULTISIG, active: false });
  assert.deepEqual(vaultAddresses({ state: 'active', multisig: MULTISIG, depositAddress: DEPOSIT, gate: readyGate, layers: { status: 'loading' }, releaseBlock: '' }), { depositAddress: DEPOSIT, multisig: MULTISIG, active: true });
});
