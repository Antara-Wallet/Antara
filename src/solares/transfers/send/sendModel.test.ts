import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBalance } from '../../wallet/balances';
import { assetRows } from '../../receive/receiveModel';
import {
  SEND_COPY, amountCheck, balanceFor, blocksTransfer, detailsTitle, maxAmount, nothingToSend, recognise, resultCopy, secondsLeft, sendRowState,
  type KnownBalance,
} from './sendModel';

const SOL = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const OTHER = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const MULTISIG = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const known = (raw: bigint, formatted: string): KnownBalance => ({ status: 'known', raw, formatted });

test('a balance is known only when signed in, loaded and present exactly once; unknown is never zero', () => {
  const balances = [canonicalBalance('solana', 1_250_000_000n, true), canonicalBalance('base', 0n, true)];
  const wallet = { authenticated: true, balancesLoading: false, balances };
  assert.deepEqual(balanceFor(wallet, 'solana', 'native'), known(1_250_000_000n, '1.25'));
  assert.deepEqual(balanceFor(wallet, 'base', 'native'), known(0n, '0'));
  assert.deepEqual(balanceFor(wallet, 'ethereum', 'native'), { status: 'unknown' }, 'a network that did not load');
  assert.deepEqual(balanceFor({ ...wallet, balancesLoading: true }, 'solana', 'native'), { status: 'unknown' });
  assert.deepEqual(balanceFor({ ...wallet, authenticated: false }, 'solana', 'native'), { status: 'unknown' });
  assert.deepEqual(balanceFor({ ...wallet, balances: [...balances, balances[0]] }, 'solana', 'native'), { status: 'unknown' }, 'duplicates are not trusted');
});

test('asset rows: known zero is not selectable ("No balance"), unknown is ("Balance unavailable"), missing wallet and devnet are not', () => {
  const [sol, usdc] = assetRows('mainnet-beta');
  assert.deepEqual(sendRowState(sol, true, known(1_250_000_000n, '1.25')), { selectable: true, note: '1.25 SOL', balance: known(1_250_000_000n, '1.25') });
  assert.equal(sendRowState(usdc, true, known(0n, '0')).note, 'No balance');
  assert.equal(sendRowState(usdc, true, known(0n, '0')).selectable, false);
  assert.deepEqual(sendRowState(usdc, true, { status: 'unknown' }), { selectable: true, note: 'Balance unavailable', balance: { status: 'unknown' } });
  assert.equal(sendRowState(sol, false, { status: 'unknown' }).note, 'No Solana wallet');
  assert.equal(sendRowState(assetRows('mainnet-beta')[2], false, { status: 'unknown' }).note, 'No EVM wallet');
  const devnetUsdc = assetRows('devnet')[1];
  assert.deepEqual(sendRowState(devnetUsdc, true, known(5n, '0.000005')), { selectable: false, note: 'Mainnet only', balance: known(5n, '0.000005') });
});

test('"Nothing to send yet" only when every sendable balance is a known zero', () => {
  const rows = assetRows('mainnet-beta');
  const zero = rows.map(row => sendRowState(row, true, known(0n, '0')));
  assert.equal(nothingToSend(zero), true);
  assert.equal(nothingToSend(zero.map((state, index) => (index === 3 ? sendRowState(rows[3], true, { status: 'unknown' }) : state))), false, 'an unknown balance may be nonzero');
  assert.equal(nothingToSend(zero.map((state, index) => (index === 0 ? sendRowState(rows[0], true, known(1n, '0.000000001')) : state))), false);
  assert.equal(nothingToSend(rows.map(row => sendRowState(row, false, { status: 'unknown' }))), false, 'no wallet is not "nothing to send"');
});

test('amounts: only a known balance makes an amount too large; invalid input is left to validation', () => {
  const balance = known(1_250_000_000n, '1.25');
  assert.equal(amountCheck('', 9, balance), 'empty');
  assert.equal(amountCheck('1.25', 9, balance), 'ok');
  assert.equal(amountCheck('1.250000001', 9, balance), 'over');
  assert.equal(amountCheck('5', 9, balance), 'over');
  assert.equal(amountCheck('5', 9, { status: 'unknown' }), 'ok');
  assert.equal(amountCheck('1.0000001', 6, balance), 'invalid');
  assert.equal(amountCheck('abc', 9, balance), 'invalid');
  assert.equal(amountCheck('0', 9, balance), 'invalid');
  assert.equal(SEND_COPY.notEnough('USDG'), 'Not enough USDG.');
});

test('Max is for stablecoins with a known, nonzero balance, and is the exact balance', () => {
  assert.equal(maxAmount('stablecoin', known(1_500_000_000_000_000_000n, '1.5')), '1.5');
  assert.equal(maxAmount('native', known(1_250_000_000n, '1.25')), null);
  assert.equal(maxAmount('stablecoin', known(0n, '0')), null);
  assert.equal(maxAmount('stablecoin', { status: 'unknown' }), null);
});

test('recognised recipients: saved, own wallet, vault deposit and vault configuration (never a plain transfer)', () => {
  const ctx = {
    saved: [{ label: 'Treasury', family: 'solana' as const, address: OTHER }, { label: 'Exchange', family: 'evm' as const, address: EVM }],
    own: [{ name: 'Solana wallet', address: SOL }],
    vault: { depositAddress: OTHER, multisig: MULTISIG },
  };
  assert.deepEqual(recognise('', 'solana', ctx), []);
  assert.deepEqual(recognise(` ${OTHER} `, 'solana', ctx).map(chip => chip.text), ['Saved as Treasury', 'Your Solana vault']);
  assert.deepEqual(recognise(SOL, 'solana', ctx).map(chip => chip.kind), ['own']);
  assert.deepEqual(recognise(EVM.toLowerCase(), 'evm', { ...ctx, own: [] }).map(chip => chip.text), ['Saved as Exchange']);
  assert.deepEqual(recognise(MULTISIG, 'solana', ctx).map(chip => chip.kind), ['vault-config']);
  assert.equal(blocksTransfer(recognise(OTHER, 'solana', ctx)), true);
  assert.equal(blocksTransfer(recognise(MULTISIG, 'solana', ctx)), true);
  assert.equal(blocksTransfer(recognise(SOL, 'solana', ctx)), false);
  // The vault is Solana only: an EVM recipient never matches it.
  assert.deepEqual(recognise(OTHER, 'evm', ctx), []);
});

test('copy: details title, result statuses (verbatim from TransferDialog), countdown', () => {
  const rows = assetRows('mainnet-beta');
  assert.equal(detailsTitle(rows[5]), 'Send USDC (Binance-Peg) on BNB Smart Chain');
  assert.equal(detailsTitle(rows[7]), 'Send USDG on Robinhood Chain');
  assert.deepEqual(['confirmed', 'submitted', 'reverted', 'submission-unknown'].map(status => resultCopy(status as never).title), ['Transfer confirmed.', 'Transfer submitted.', 'Transfer reverted.', 'Awaiting wallet outcome.']);
  assert.equal(secondsLeft(90_000, 0), 90);
  assert.equal(secondsLeft(90_000, 89_001), 1);
  assert.equal(secondsLeft(90_000, 90_000), 0);
  assert.equal(secondsLeft(90_000, 95_000), 0);
  assert.equal(SEND_COPY.visibility, 'Public on-chain transaction');
  assert.equal(SEND_COPY.banner, 'Spending wallet · funds here are not protected by your vault.');
});
