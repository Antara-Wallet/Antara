import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SignatureStatus } from '@solana/web3.js';
import { TransferNotSubmittedError, sendSolanaTransfer, settleSolanaTransfer, type PreparedTransfer } from './transfer';
import { SOLANA_UNCONFIRMED_TEXT, SolanaTransactionExpiredError, type SolanaStatusRpc } from '../wallet/solanaConfirm';
import { SolanaSendError } from '../wallet/solanaSend';

const SIGNATURE = '5DTiEnez4Urj1kdjA3wLiKoAuq3bqkEpP638Jm1RSHTcXPvxWb7xPT7eiRbQWNMioUuVWKusY8T7Zstes5fFLke1';
const review = (): PreparedTransfer => ({
  chain: 'solana', asset: 'native', sender: '7Ld5aPu2eX4QwVbY3Kc3jTH2EGBQYCmQ5wZqJ8nNYw1F', recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: '0.01',
  amountRaw: 10_000_000n, fee: '0.000005 SOL', symbol: 'SOL', expires: Date.now() + 60_000, rent: '0',
  solana: { transaction: new Uint8Array([1, 2, 3]), blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 2_000 },
});

test('a Solana transfer returns the signature from the wallet send, passing the reviewed bytes exactly', async () => {
  const transfer = review();
  let sent: Uint8Array | null = null;
  assert.equal(await sendSolanaTransfer(transfer, async bytes => { sent = bytes; return SIGNATURE; }), SIGNATURE);
  assert.deepEqual(sent, transfer.solana!.transaction);
});

test('incident: a broadcast whose answer was lost keeps its signature, so the payment is followed instead of repeated', async () => {
  assert.equal(await sendSolanaTransfer(review(), async () => { throw new SolanaSendError('lost', SIGNATURE, 'unknown'); }), SIGNATURE);
  // A wallet that broadcast by itself without returning a signature stays unknown (never "not submitted").
  await assert.rejects(sendSolanaTransfer(review(), async () => { throw new SolanaSendError('lost', '', 'unknown'); }), error => error instanceof SolanaSendError && !(error instanceof TransferNotSubmittedError));
});

test('a refusal before sending, a cancelled signature or a changed wallet is definitively not submitted', async () => {
  for (const failure of [new SolanaSendError('Solana refused this transaction before sending it. Nothing was sent.', SIGNATURE, false), Object.assign(new Error('User rejected the request.'), { code: 4001 }), new Error('Your wallet changed.')]) {
    await assert.rejects(sendSolanaTransfer(review(), async () => { throw failure; }), error => error instanceof TransferNotSubmittedError && error.message === failure.message);
  }
  await assert.rejects(sendSolanaTransfer({ ...review(), solana: undefined }, async () => SIGNATURE), TransferNotSubmittedError);
});

function statusRpc(status: Partial<SignatureStatus> | null, height = 1_000) {
  return {
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [status ? { slot: 5, confirmations: null, err: null, ...status } : null] }),
    getBlockHeight: async () => height,
    isBlockhashValid: async () => ({ context: { slot: 1 }, value: false }),
  } as unknown as SolanaStatusRpc;
}
const fast = () => { let clock = 0; return { now: () => clock, sleep: async (ms: number) => { clock += ms; } }; };

test('a sent Solana transfer settles by polling: confirmed, reverted, expired or still unknown', async () => {
  assert.equal(await settleSolanaTransfer(statusRpc({ confirmationStatus: 'finalized' }), review(), SIGNATURE, fast()), 'confirmed');
  assert.equal(await settleSolanaTransfer(statusRpc({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }), review(), SIGNATURE, fast()), 'reverted');
  await assert.rejects(settleSolanaTransfer(statusRpc(null, 2_001), review(), SIGNATURE, fast()), error => error instanceof SolanaTransactionExpiredError && error.signature === SIGNATURE);
  await assert.rejects(settleSolanaTransfer(statusRpc({ confirmationStatus: 'processed' }), review(), SIGNATURE, fast()), new RegExp(SOLANA_UNCONFIRMED_TEXT));
});
