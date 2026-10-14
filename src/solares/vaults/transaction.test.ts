import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preserveVaultTransaction, waitForVaultReceipt, VaultTransactionError } from './transaction';
import type { Hex } from 'viem';

test('receipt timeouts and verification failures preserve the real transaction hash without claiming false confirmation', async () => {
  for (const confirmed of [false, true]) {
    await assert.rejects(preserveVaultTransaction('actual-broadcast-hash', async () => { throw new Error('RPC unavailable'); }, confirmed), error => {
      assert.ok(error instanceof VaultTransactionError);
      assert.equal(error.signature, 'actual-broadcast-hash');
      assert.equal(error.confirmed, confirmed);
      return true;
    });
  }
});

const hash = `0x${'ab'.repeat(32)}` as Hex;
test('vault confirmation tracks only the original hash and opts out of replacement receipts', async () => {
  const receipt = { transactionHash: hash, status: 'success' as const };
  const result = await waitForVaultReceipt(hash, 1, {
    getChainId: async () => 1,
    waitForTransactionReceipt: async parameters => {
      assert.deepEqual(parameters, { hash, timeout: 60_000, checkReplacement: false }); return receipt;
    },
  });
  assert.equal(result, receipt);
  await assert.rejects(waitForVaultReceipt(hash, 1, {
    getChainId: async () => 1,
    waitForTransactionReceipt: async () => ({ transactionHash: `0x${'cd'.repeat(32)}`, status: 'success' }),
  }), error => {
    assert.ok(error instanceof VaultTransactionError);
    assert.equal(error.signature, hash); assert.equal(error.confirmed, false); assert.match(error.message, /different transaction/); return true;
  });
});

test('switching networks during vault confirmation retains the broadcast hash as unresolved', async () => {
  let checks = 0;
  await assert.rejects(waitForVaultReceipt(hash, 1, {
    getChainId: async () => ++checks === 1 ? 1 : 8453,
    waitForTransactionReceipt: async () => ({ transactionHash: hash, status: 'success' }),
  }), error => {
    assert.ok(error instanceof VaultTransactionError);
    assert.equal(error.signature, hash); assert.equal(error.outcome, 'unknown'); return true;
  });
});

test('an on-chain revert retains evidence and is distinguished from a receipt timeout', async () => {
  await assert.rejects(waitForVaultReceipt(hash, 1, {
    getChainId: async () => 1,
    waitForTransactionReceipt: async () => ({ transactionHash: hash, status: 'reverted' }),
  }), error => {
    assert.ok(error instanceof VaultTransactionError);
    assert.equal(error.signature, hash); assert.equal(error.confirmed, true); assert.equal(error.outcome, 'reverted'); return true;
  });
});

test('a definitive Solana confirmation failure retains its reverted classification through the broadcast wrapper', async () => {
  const failure = new VaultTransactionError('The Solana transaction failed on-chain.', 'solana-broadcast-signature', true, 'reverted');
  await assert.rejects(preserveVaultTransaction(failure.signature, async () => { throw failure; }), error => {
    assert.equal(error, failure);
    assert.equal(failure.outcome, 'reverted');
    assert.equal(failure.confirmed, true);
    return true;
  });
});
