import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_SOLANA_USDC, exactAmount, readSolanaRentMinimum, releaseAmountProblem, solDepositProblem, solMinimumText, solRecipientProblem, solReleaseProblem, usdcDepositProblem,
} from './vaultAmounts';

// The mainnet value observed on 2026-10-13. The app always reads it live; tests pin it.
const MINIMUM = 650_240n;

test('the stated SOL minimum is rounded up, so it is always enough', () => {
  assert.equal(solMinimumText(MINIMUM), '0.00066');
  assert.equal(solMinimumText(890_880n), '0.0009');
  assert.equal(solMinimumText(660_000n), '0.00066');
  assert.equal(solMinimumText(1n), '0.00001');
  assert.equal(solMinimumText(0n), '0');
  assert.equal(exactAmount(1_234_567_891n, 'SOL'), '1.234567891');
  assert.equal(exactAmount(5_000_000n, 'USDC'), '5');
});

test('the rent minimum is read live for a 0-byte account and must be a positive whole number', async () => {
  const asked: unknown[][] = [];
  const connection = (value: number) => ({ getMinimumBalanceForRentExemption: async (...args: unknown[]) => { asked.push(args); return value; } });
  assert.equal(await readSolanaRentMinimum(connection(650_240)), 650_240n);
  assert.deepEqual(asked[0], [0, 'confirmed']);
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) await assert.rejects(readSolanaRentMinimum(connection(bad)), /invalid minimum/);
});

test('a first SOL deposit must reach the minimum; later deposits of any size are fine', () => {
  assert.equal(solDepositProblem(0n, 500_000n, MINIMUM), 'The first SOL deposit must be at least 0.00066 SOL. Solana needs this minimum to open your vault’s account.');
  assert.equal(solDepositProblem(0n, MINIMUM - 1n, MINIMUM)?.startsWith('The first SOL deposit must be at least 0.00066 SOL'), true);
  assert.equal(solDepositProblem(0n, MINIMUM, MINIMUM), null, 'exactly the minimum');
  assert.equal(solDepositProblem(0n, 1_000_000n, MINIMUM), null);
  assert.equal(solDepositProblem(MINIMUM, 1n, MINIMUM), null, 'a funded vault takes any amount');
  assert.match(solDepositProblem(600_000n, 1n, MINIMUM)!, /at least 0\.00006 SOL so your vault keeps Solana’s minimum balance/);
});

test('a SOL release takes everything or leaves at least the minimum', () => {
  const balance = 5_000_000n;
  assert.equal(solReleaseProblem(balance, balance, MINIMUM), null, 'release all');
  assert.equal(solReleaseProblem(balance, balance - MINIMUM, MINIMUM), null, 'leaves exactly the minimum');
  assert.equal(solReleaseProblem(balance, 1n, MINIMUM), null);
  assert.equal(solReleaseProblem(balance, balance - 100_000n, MINIMUM),
    'Release all 0.005 SOL, or at most 0.00434 SOL so 0.00066 SOL stays in your vault. Solana doesn’t let an account keep less than that unless it is emptied.');
  assert.equal(solReleaseProblem(balance, balance - 1n, MINIMUM)?.startsWith('Release all 0.005 SOL'), true);
  assert.equal(solReleaseProblem(balance, balance + 1n, MINIMUM), 'Your vault holds 0.005 SOL.');
  // A vault at or near the minimum can only be emptied.
  assert.equal(solReleaseProblem(655_000n, 10_000n, MINIMUM), 'Release all 0.000655 SOL. Solana doesn’t let your vault keep less than 0.00066 SOL unless it is emptied.');
  assert.equal(solReleaseProblem(655_000n, 1_000n, MINIMUM), null, 'still leaves the exact minimum');
  assert.equal(solReleaseProblem(655_000n, 655_000n, MINIMUM), null);
  // The suggested maximum really leaves enough.
  const most = 5_000_000n - 660_000n;
  assert.equal(solReleaseProblem(balance, most, MINIMUM), null);
});

test('an empty receiving wallet must get at least the minimum', () => {
  assert.equal(solRecipientProblem(0n, 100_000n, MINIMUM), 'The receiving wallet has no SOL yet, so this release must be at least 0.00066 SOL.');
  assert.equal(solRecipientProblem(0n, MINIMUM, MINIMUM), null);
  assert.equal(solRecipientProblem(1_000_000n, 1n, MINIMUM), null);
  assert.match(solRecipientProblem(600_000n, 1n, MINIMUM)!, /at least 0\.00006 SOL so the receiving wallet keeps/);
});

test('a USDC deposit needs USDC on Solana in this wallet', () => {
  assert.equal(usdcDepositProblem(null, 10_000n), NO_SOLANA_USDC);
  assert.equal(NO_SOLANA_USDC, 'You have no USDC on Solana in this wallet.');
  assert.equal(usdcDepositProblem(0n, 10_000n), NO_SOLANA_USDC);
  assert.equal(usdcDepositProblem(5_000_000n, 5_000_001n), 'This wallet holds 5 USDC on Solana, less than this deposit.');
  assert.equal(usdcDepositProblem(5_000_000n, 5_000_000n), null);
});

test('the release form checks the vault balance, and the SOL minimum once it is read', () => {
  assert.equal(releaseAmountProblem('USDC', 2_000_000n, 1_000_000n, MINIMUM), 'Your vault holds 1 USDC.');
  assert.equal(releaseAmountProblem('USDC', 999_999n, 1_000_000n, MINIMUM), null, 'USDC has no account minimum here');
  assert.equal(releaseAmountProblem('SOL', 900_000n, 1_000_000n, null), null, 'until the minimum is read, only the balance is checked');
  assert.equal(releaseAmountProblem('SOL', 1_000_001n, 1_000_000n, null), 'Your vault holds 0.001 SOL.');
  assert.match(releaseAmountProblem('SOL', 900_000n, 1_000_000n, MINIMUM)!, /^Release all 0\.001 SOL/);
  assert.equal(releaseAmountProblem('SOL', 1_000_000n, 1_000_000n, MINIMUM), null);
});
