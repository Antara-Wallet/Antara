import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as multisig from '@sqds/multisig';
import { PublicKey } from '@solana/web3.js';
import { NEVER_CLAIM } from '../layers/claims';
import {
  CREATION_COST_FALLBACK, CREATION_SIGNATURES, LAMPORTS_PER_SIGNATURE, PAIRED_MULTISIG_SPACE,
  creationCostDetail, creationFunding, roundedSol, solText, vaultCreationCost,
} from './creationCost';
import { peekVaultIntent, requestVaultCreation, requestVaultIntent, takeVaultIntent } from './vaultIntent';

// Mainnet values read on 2026-10-13: rent for 198 bytes and for 0 bytes, Squads multisigCreationFee 0.
const live = vaultCreationCost({ rent: 1_656_080n, programFee: 0n, walletReserve: 650_240n });

test('the multisig space is the serialized size of a paired (2-member) Squads multisig', () => {
  const key = PublicKey.default;
  const size = multisig.accounts.Multisig.byteSize({
    createKey: key, configAuthority: key, threshold: 2, timeLock: 0, transactionIndex: 0, staleTransactionIndex: 0, rentCollector: key, bump: 255,
    members: [{ key, permissions: { mask: 7 } }, { key, permissions: { mask: 2 } }],
  });
  assert.equal(PAIRED_MULTISIG_SPACE, size);
});

test('the cost adds rent, the Squads fee, two base signature fees and the wallet reserve', () => {
  assert.equal(live.networkFee, CREATION_SIGNATURES * LAMPORTS_PER_SIGNATURE);
  assert.equal(live.networkFee, 10_000n);
  assert.equal(live.total, 1_656_080n + 0n + 10_000n + 650_240n);
  const withFee = vaultCreationCost({ rent: 1n, programFee: 100_000_000n, walletReserve: 1n });
  assert.equal(withFee.total, 100_010_002n);
  assert.throws(() => vaultCreationCost({ rent: -1n, programFee: 0n, walletReserve: 0n }));
});

test('amounts shown are rounded up, never below what is needed', () => {
  assert.equal(roundedSol(live.total), '0.0024');
  assert.equal(roundedSol(2_300_000n), '0.0023');
  assert.equal(roundedSol(2_300_001n), '0.0024');
  assert.equal(solText(1_656_080n), '0.001657');
  assert.equal(solText(10_000n), '0.00001');
  const detail = creationCostDetail(live);
  assert.match(detail, /0\.001657 SOL rent for the vault account/);
  assert.doesNotMatch(detail, /Squads fee/);
  assert.match(creationCostDetail(vaultCreationCost({ rent: 1n, programFee: 50_000_000n, walletReserve: 1n })), /0\.05 SOL Squads fee/);
  for (const pattern of NEVER_CLAIM) assert.doesNotMatch(detail, pattern);
});

test('funding is short only for a known balance below the known cost; unknown is never short', () => {
  assert.equal(creationFunding(live, live.total), 'met');
  assert.equal(creationFunding(live, live.total - 1n), 'short');
  assert.equal(creationFunding(live, 0n), 'short');
  assert.equal(creationFunding(live, null), 'unknown');
  // Without a live cost only a known zero is short; any other figure would be a guess.
  assert.equal(creationFunding(null, 0n), 'short');
  assert.equal(creationFunding(null, 1n), 'unknown');
  assert.equal(creationFunding(null, null), 'unknown');
  assert.equal(CREATION_COST_FALLBACK, 'about 0.01–0.02 SOL');
});

test('a vault intent is taken once and expires', () => {
  assert.equal(takeVaultIntent(), null);
  requestVaultCreation();
  assert.deepEqual(peekVaultIntent(), { kind: 'create' });
  assert.deepEqual(takeVaultIntent(), { kind: 'create' });
  assert.equal(takeVaultIntent(), null);
  requestVaultIntent({ kind: 'layer', layer: 'mfa' }, 1_000);
  assert.equal(takeVaultIntent(1_000 + 60_001), null);
  requestVaultIntent({ kind: 'layer', layer: 'wifi' }, 1_000);
  assert.deepEqual(takeVaultIntent(1_000 + 59_000), { kind: 'layer', layer: 'wifi' });
});
