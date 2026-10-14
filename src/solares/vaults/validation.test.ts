import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SQUADS_TIME_LOCK_SECONDS, assertSameOwners, assertReviewedVaultPolicy, parseAmount, validatePairedVault, validateVaultPolicy, type ReviewedVaultPolicy,
} from './validation';

describe('vault safety invariants', () => {
  const valid = { owners: ['owner', 'guardian', 'recovery'], userAddress: 'owner', threshold: 2, chain: 'solana' as const, timeLockSeconds: 86400 };
  it('rejects single-owner and single-signature protection claims', () => {
    assert.throws(() => validateVaultPolicy({ ...valid, threshold: 1 }));
    assert.throws(() => validateVaultPolicy({ ...valid, owners: ['owner'] }));
  });
  it('rejects duplicate and unrelated owner sets, and accepts a Squads time lock of 0 (the default, no delay)', () => {
    assert.throws(() => validateVaultPolicy({ ...valid, owners: ['owner', 'owner'] }));
    assert.throws(() => validateVaultPolicy({ ...valid, userAddress: 'intruder' }));
    // Owner decision 2026-10-13: no mandatory 1-hour minimum or 24-hour default delay for independent-owner Squads vaults.
    assert.equal(DEFAULT_SQUADS_TIME_LOCK_SECONDS, 0);
    for (const timeLockSeconds of [0, 1, 3599, 3600, 86_400, 7_776_000]) assert.doesNotThrow(() => validateVaultPolicy({ ...valid, timeLockSeconds }), String(timeLockSeconds));
    for (const timeLockSeconds of [-1, 1.5, 7_776_001, Number.NaN, undefined]) assert.throws(() => validateVaultPolicy({ ...valid, timeLockSeconds }), /time lock/, String(timeLockSeconds));
    assert.throws(() => validateVaultPolicy({ ...valid, chain: 'evm', owners: ['0xAbC', '0xabc'], userAddress: '0xAbC' }));
  });
  it('retains large exact balances and fails on ambiguous amount formats', () => {
    assert.equal(parseAmount('9007199254740993.123456', 6), 9007199254740993123456n);
    assert.equal(parseAmount('0.000000001', 9), 1n);
    for (const value of ['0', '-1', '1e3', '.1', '1.', '01', 'Infinity', '1.0000001']) assert.throws(() => parseAmount(value, 6));
  });
  it('treats EVM addresses case-insensitively and Solana case-sensitively', () => {
    assert.doesNotThrow(() => assertSameOwners(['0xABC', '0xdef'], ['0xDEF', '0xabc'], 'evm'));
    assert.throws(() => assertSameOwners(['Abc', 'def'], ['abc', 'def'], 'solana'));
  });
});

describe('reviewed vault configuration is binding', () => {
  const safe: ReviewedVaultPolicy = { kind: 'safe', address: '0xVAULT', depositAddress: '0xVAULT', chainId: 1, version: '1.4.1', owners: ['0xA', '0xB', '0xC'], threshold: 3, timeLockSeconds: 0 };
  const squads: ReviewedVaultPolicy = { kind: 'squads', address: 'Squad', depositAddress: 'Vault', cluster: 'mainnet-beta', owners: ['A', 'B', 'C'], threshold: 3, timeLockSeconds: 86400 };
  it('blocks a valid but weakened or different Safe policy after the review', () => {
    for (const change of [{ threshold: 2 }, { owners: ['0xA', '0xB', '0xATTACKER'] }, { chainId: 8453 }, { version: '1.5.0' }, { depositAddress: '0xOTHER' }]) {
      assert.throws(() => assertReviewedVaultPolicy({ ...safe, ...change }, safe), /configuration changed/);
    }
  });
  it('blocks shorter Squads delays, changed members, and a switch to another cluster', () => {
    for (const change of [{ threshold: 2 }, { timeLockSeconds: 3600 }, { owners: ['A', 'B', 'attacker'] }, { cluster: 'devnet' }, { address: 'Other' }]) {
      assert.throws(() => assertReviewedVaultPolicy({ ...squads, ...change }, squads), /configuration changed/);
    }
    assert.throws(() => assertReviewedVaultPolicy({ ...squads, owners: ['a', 'B', 'C'] }, squads), /configuration changed/);
  });
  it('accepts owner ordering and EVM casing changes without hiding policy changes', () => {
    assert.doesNotThrow(() => assertReviewedVaultPolicy({ ...safe, address: '0xvault', depositAddress: '0xvault', owners: ['0xc', '0xa', '0xb'] }, safe));
    assert.doesNotThrow(() => assertReviewedVaultPolicy({ ...squads, owners: ['C', 'A', 'B'] }, squads));
  });
});
describe('paired Solana vault policy', () => {
  const paired = { members: [{ address: 'User', permissions: 7 }, { address: 'Guardian', permissions: 2 }], threshold: 2, timeLockSeconds: 0, configAuthority: null, userAddress: 'User', guardian: 'Guardian', pinnedGuardian: 'Guardian' };
  it('accepts exactly {U:7, G:2}, threshold 2, no config authority, with the pinned guardian', () => {
    assert.doesNotThrow(() => validatePairedVault(paired));
    assert.doesNotThrow(() => validatePairedVault({ ...paired, members: [...paired.members].reverse() }));
  });
  it('refuses any guardian other than the build pin, and a build without one', () => {
    assert.throws(() => validatePairedVault({ ...paired, pinnedGuardian: '' }), /no pinned ANTARA guardian/);
    assert.throws(() => validatePairedVault({ ...paired, pinnedGuardian: 'OtherGuardian' }), /does not match/);
    assert.throws(() => validatePairedVault({ ...paired, guardian: 'Attacker', members: [{ address: 'User', permissions: 7 }, { address: 'Attacker', permissions: 2 }] }), /does not match/);
  });
  it('refuses a wider guardian, a narrower user, extra members, another threshold, any time lock or an admin', () => {
    for (const change of [
      { members: [{ address: 'User', permissions: 7 }, { address: 'Guardian', permissions: 7 }] },
      { members: [{ address: 'User', permissions: 7 }, { address: 'Guardian', permissions: 3 }] },
      { members: [{ address: 'User', permissions: 3 }, { address: 'Guardian', permissions: 2 }] },
      { members: [...paired.members, { address: 'Recovery', permissions: 7 }] },
      { members: [{ address: 'User', permissions: 7 }, { address: 'User', permissions: 2 }] },
      { threshold: 1 }, { threshold: 3 }, { configAuthority: 'Admin' }, { timeLockSeconds: -1 }, { timeLockSeconds: 1 }, { timeLockSeconds: 3600 }, { timeLockSeconds: 7_776_001 }, { userAddress: 'Guardian' },
    ]) assert.throws(() => validatePairedVault({ ...paired, ...change }), JSON.stringify(change));
  });
  it('leaves independent-owner vaults on their own rules: at least two approvals, and no mandatory delay', () => {
    assert.doesNotThrow(() => validateVaultPolicy({ owners: ['User', 'Guardian'], userAddress: 'User', threshold: 2, chain: 'solana', timeLockSeconds: 0 }));
    assert.throws(() => validateVaultPolicy({ owners: ['User', 'Guardian'], userAddress: 'User', threshold: 1, chain: 'solana', timeLockSeconds: 0 }), /at least 2/);
  });
});
