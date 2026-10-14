import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import {
  SolanaSendError, broadcastSignedTransaction, completeSignedTransaction, isUserRejection, possiblySentSignature, sendThroughWallet,
  signAndBroadcastSolanaTransaction, walletCanSignOnly,
} from './solanaSend';
import { SOLANA_SEND_UNKNOWN_TEXT } from '../ui/friendlyError';
import { confirmSolanaSignature, type SolanaStatusRpc } from './solanaConfirm';

const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);
function transfer(payer = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()) {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000n })] }).compileToV0Message();
  return { payer, blockhash, requested: new VersionedTransaction(message).serialize() };
}
/** What a wallet's signTransaction returns: the requested transaction with its signature added. */
function walletSigns(requested: Uint8Array, ...keys: Keypair[]) {
  const tx = VersionedTransaction.deserialize(requested);
  tx.sign(keys);
  return tx.serialize();
}
type Broadcast = { bytes: Uint8Array; options: unknown };
function rpc(answer: (bytes: Uint8Array) => Promise<string>) {
  const sent: Broadcast[] = [];
  const connection = {
    async sendRawTransaction(bytes: Uint8Array, options: unknown) { sent.push({ bytes, options }); return answer(bytes); },
    // A send never waits for confirmation: these must not be called.
    async getSignatureStatuses() { throw new Error('send must not confirm'); },
    async confirmTransaction() { throw new Error('send must not confirm'); },
  } as unknown as Pick<Connection, 'sendRawTransaction'>;
  return { connection, sent };
}

test('the transaction id is the fee payer signature read from the signed bytes, and the exact message is kept', () => {
  const { payer, requested } = transfer();
  const signed = walletSigns(requested, payer);
  const result = completeSignedTransaction(requested, signed, payer.publicKey.toBase58());
  assert.equal(result.signature, base58(VersionedTransaction.deserialize(signed).signatures[0]));
  assert.deepEqual(result.bytes, signed);
});

test('a wallet that changes the reviewed message, drops a signature or returns garbage is refused before anything is sent', () => {
  const { payer, requested } = transfer();
  const other = transfer(payer);
  assert.throws(() => completeSignedTransaction(requested, walletSigns(other.requested, payer), payer.publicKey.toBase58()), /changed this transaction.*Nothing was sent/);
  assert.throws(() => completeSignedTransaction(requested, requested, payer.publicKey.toBase58()), /did not sign.*Nothing was sent/);
  assert.throws(() => completeSignedTransaction(requested, new Uint8Array([1, 2, 3]), payer.publicKey.toBase58()), /could not read.*Nothing was sent/);
});

test('a bare 64-byte signature (WalletConnect) is placed in the signer slot of the requested transaction', () => {
  const { payer, requested } = transfer();
  const signature = VersionedTransaction.deserialize(walletSigns(requested, payer)).signatures[0];
  const result = completeSignedTransaction(requested, signature, payer.publicKey.toBase58());
  assert.equal(result.signature, base58(signature));
  assert.deepEqual(result.bytes, walletSigns(requested, payer));
  assert.throws(() => completeSignedTransaction(requested, signature, Keypair.generate().publicKey.toBase58()), /did not sign/);
});

test('a pre-signed new-account key (vault createKey) must survive the wallet unchanged', () => {
  const payer = Keypair.generate(), createKey = Keypair.generate();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: createKey.publicKey, lamports: 1_000_000, space: 0, programId: SystemProgram.programId }),
  ] }).compileToV0Message();
  const partial = new VersionedTransaction(message);
  partial.sign([createKey]);
  const requested = partial.serialize();
  assert.ok(completeSignedTransaction(requested, walletSigns(requested, payer), payer.publicKey.toBase58()).signature);
  const tampered = VersionedTransaction.deserialize(walletSigns(requested, payer));
  tampered.signatures[1] = new Uint8Array(64).fill(7);
  assert.throws(() => completeSignedTransaction(requested, tampered.serialize(), payer.publicKey.toBase58()), /changed this transaction/);
});

test('incident: the signature is returned as soon as the RPC accepts the broadcast, with no confirmation wait', async () => {
  // Privy's signAndSendTransaction broadcast and then threw "Transaction confirmation timed out", losing the signature.
  const { payer, requested } = transfer();
  const steps: string[] = [];
  const { connection, sent } = rpc(async bytes => base58(VersionedTransaction.deserialize(bytes).signatures[0]));
  const signature = await signAndBroadcastSolanaTransaction(requested, {
    signer: payer.publicKey.toBase58(), rpc: connection,
    sign: async bytes => { steps.push('sign'); return walletSigns(bytes, payer); },
    beforeBroadcast: () => steps.push('session check'),
  });
  assert.deepEqual(steps, ['sign', 'session check']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { skipPreflight: false, preflightCommitment: 'confirmed' });
  assert.equal(signature, base58(VersionedTransaction.deserialize(sent[0].bytes).signatures[0]));
});

test('a session change after signing stops the broadcast', async () => {
  const { payer, requested } = transfer();
  const { connection, sent } = rpc(async () => 'never');
  await assert.rejects(signAndBroadcastSolanaTransaction(requested, {
    signer: payer.publicKey.toBase58(), rpc: connection, sign: async bytes => walletSigns(bytes, payer),
    beforeBroadcast: () => { throw new Error('Your wallet changed.'); },
  }), /Your wallet changed/);
  assert.equal(sent.length, 0);
});

test('a lost or failed answer after the broadcast keeps the signature and says it may have gone through', async () => {
  const { payer, requested } = transfer();
  const { bytes, signature } = completeSignedTransaction(requested, walletSigns(requested, payer), payer.publicKey.toBase58());
  for (const failure of [
    new TypeError('fetch failed'), new Error('502 Bad Gateway: {"error":{"message":"Solana could not be reached."}}'), new Error('408 Request Timeout: '),
    // A provider's or gateway's error answer that may follow a forward to the leader is not a refusal,
    // even when it contains words such as "invalid", "not available" or "too many".
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Internal error' }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Internal error: invalid response from upstream node' }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Service not available after forward' }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Too many requests for a specific RPC call' }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'unsupported upstream response' }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: internal error' }),
  ]) {
    const { connection, sent } = rpc(async () => { throw failure; });
    await assert.rejects(broadcastSignedTransaction(connection, bytes, signature), error => {
      assert.ok(error instanceof SolanaSendError);
      assert.equal(error.submitted, 'unknown');
      assert.equal(error.signature, signature);
      assert.equal(error.message, SOLANA_SEND_UNKNOWN_TEXT);
      assert.equal(possiblySentSignature(error), signature);
      return true;
    });
    assert.equal(sent.length, 1, 'never re-signed or re-sent automatically');
  }
  // An RPC that names another signature is not trusted as "sent".
  const odd = rpc(async () => 'another-signature');
  await assert.rejects(broadcastSignedTransaction(odd.connection, bytes, signature), (error: SolanaSendError) => error.submitted === 'unknown' && error.signature === signature);
});

test('an RPC refusal before sending is definitive: nothing was sent', async () => {
  const { payer, requested } = transfer();
  const { bytes, signature } = completeSignedTransaction(requested, walletSigns(requested, payer), payer.publicKey.toBase58());
  const cases: [unknown, RegExp][] = [
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1', logs: [] }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Blockhash not found' }), /expired before it was sent/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.' }), /enough SOL/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1 (Error: insufficient funds)' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction signature verification failure' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Node is behind by 42 slots' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Node is unhealthy' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction precompile verification failure InvalidSignature' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'invalid transaction: Transaction failed to sanitize accounts offsets correctly' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'failed to deserialize solana_transaction::versioned::VersionedTransaction: io error' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Invalid params: invalid type: integer, expected a string.' }), /refused this transaction/],
    [new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Minimum context slot has not been reached' }), /refused this transaction/],
    [new Error('429 Too Many Requests: {"error":{"message":"Too many Solana requests."}}'), /refused this transaction/],
    [new Error('400 Bad Request: {"error":{"message":"Method not available."}}'), /refused this transaction/],
  ];
  for (const [failure, message] of cases) {
    const { connection } = rpc(async () => { throw failure; });
    await assert.rejects(broadcastSignedTransaction(connection, bytes, signature), error => {
      assert.ok(error instanceof SolanaSendError);
      assert.equal(error.submitted, false);
      assert.match(error.message, message);
      assert.match(error.message, /Nothing was sent/);
      assert.equal(possiblySentSignature(error), null);
      return true;
    });
  }
});

test('"already processed" means it is on-chain under this signature', async () => {
  const { payer, requested } = transfer();
  const { bytes, signature } = completeSignedTransaction(requested, walletSigns(requested, payer), payer.publicKey.toBase58());
  const { connection } = rpc(async () => { throw new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: This transaction has already been processed' }); });
  assert.equal(await broadcastSignedTransaction(connection, bytes, signature), signature);
});

test('a wallet that can only sign and send: a refusal passes through, any other failure is unknown without a signature', async () => {
  assert.equal(await sendThroughWallet(async () => 'sig'), 'sig');
  // The wallet may have replaced the blockhash: its signature is never reported expired, only followed.
  let heights = 0;
  const followed = await confirmSolanaSignature({
    rpc: { getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }), getBlockHeight: async () => { heights++; return 10_000; } } as unknown as SolanaStatusRpc,
    signature: 'sig', blockhash: 'B', lastValidBlockHeight: 1, timeoutMs: 3_000, intervalMs: 1_000, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1_000); })(),
  });
  assert.deepEqual(followed, { outcome: 'unknown', seen: false });
  assert.equal(heights, 0);
  const refusal = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  await assert.rejects(sendThroughWallet(async () => { throw refusal; }), error => error === refusal);
  assert.equal(isUserRejection(refusal), true);
  await assert.rejects(sendThroughWallet(async () => { throw new Error('Transaction confirmation timed out'); }), (error: SolanaSendError) => error instanceof SolanaSendError && error.submitted === 'unknown' && error.signature === '');
  assert.equal(walletCanSignOnly({ standardWallet: { features: { 'solana:signTransaction': {}, 'solana:signAndSendTransaction': {} } } }), true);
  assert.equal(walletCanSignOnly({ standardWallet: { features: { 'solana:signAndSendTransaction': {} } } }), false);
  assert.equal(walletCanSignOnly({}), true);
});
