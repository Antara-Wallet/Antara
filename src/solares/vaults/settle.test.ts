import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type SignatureStatus } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { sendSimulatedVaultTransaction } from './preflight';
import { VaultTransactionError, preserveVaultTransaction, settleSolanaVaultTransaction } from './transaction';
import { SOLANA_EXPIRED_TEXT, SolanaTransactionExpiredError } from '../wallet/solanaConfirm';
import { SolanaSendError, signAndBroadcastSolanaTransaction } from '../wallet/solanaSend';
import { friendlyError } from '../ui/friendlyError';

const LAST_VALID = 5_000;
/**
 * A fake Solana network behind ANTARA's HTTP RPC: it simulates, accepts broadcasts and answers
 * status polls. It has no websocket API at all, so any subscription-based confirmation would fail.
 */
function network(options: { landed?: Partial<SignatureStatus> | null; lostAnswer?: boolean; refuse?: boolean; height?: number | 'fail' } = {}) {
  const log: string[] = [];
  const onChain = new Set<string>();
  const connection = {
    async simulateTransaction() { log.push('simulate'); return { context: { slot: 1 }, value: { err: null, logs: [] } }; },
    async sendRawTransaction(bytes: Uint8Array) {
      log.push('broadcast');
      const signature = getBase58Decoder().decode(VersionedTransaction.deserialize(bytes).signatures[0]);
      if (options.refuse) throw new Error('400 Bad Request: {"error":{"message":"Method not available."}}');
      onChain.add(signature);
      if (options.lostAnswer) throw new TypeError('fetch failed');
      return signature;
    },
    async getSignatureStatuses([signature]: string[]) {
      log.push('status');
      const landed = options.landed === undefined ? { confirmationStatus: 'finalized' as const } : options.landed;
      return { context: { slot: 2 }, value: [landed && onChain.has(signature) ? { slot: 77, confirmations: null, err: null, ...landed } : null] };
    },
    async getBlockHeight() {
      if (options.height === 'fail') throw new TypeError('fetch failed');
      return options.height ?? LAST_VALID - 10;
    },
    async isBlockhashValid() { return { context: { slot: 2 }, value: false }; },
  };
  return { connection: connection as unknown as Pick<Connection, 'simulateTransaction' | 'getSignatureStatuses' | 'getBlockHeight' | 'isBlockhashValid' | 'sendRawTransaction'>, log, onChain };
}
function deposit() {
  const payer = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1n })] }).compileToV0Message());
  return { payer, tx, lifetime: { blockhash, lastValidBlockHeight: LAST_VALID } };
}
/** The vault send path as the app wires it: simulation, the wallet signing only, ANTARA's broadcast, then polling. */
function vaultSend(net: ReturnType<typeof network>, { payer, tx, lifetime }: ReturnType<typeof deposit>) {
  let walletPrompts = 0;
  const send = (bytes: Uint8Array) => signAndBroadcastSolanaTransaction(bytes, {
    signer: payer.publicKey.toBase58(), rpc: net.connection,
    sign: async requested => { walletPrompts++; net.log.push('sign'); const signed = VersionedTransaction.deserialize(requested); signed.sign([payer]); return signed.serialize(); },
  });
  let clock = 0;
  const run = () => settleSolanaVaultTransaction(net.connection, lifetime, () => sendSimulatedVaultTransaction(net.connection, tx, send), {
    now: () => clock, sleep: async ms => { clock += ms; },
  });
  return { run, prompts: () => walletPrompts };
}

test('a vault deposit is simulated, signed once, broadcast by ANTARA and confirmed by HTTP polling', async () => {
  const net = network();
  const flow = vaultSend(net, deposit());
  const signature = await flow.run();
  assert.equal(net.onChain.has(signature), true);
  assert.deepEqual(net.log, ['simulate', 'sign', 'broadcast', 'status']);
  assert.equal(flow.prompts(), 1);
});

test('incident: the answer to the broadcast is lost, yet the deposit is followed by its signature and reported confirmed (no duplicate)', async () => {
  const net = network({ lostAnswer: true });
  const flow = vaultSend(net, deposit());
  const signature = await flow.run();
  assert.equal(net.onChain.has(signature), true);
  assert.equal(flow.prompts(), 1);
  assert.equal(net.log.filter(step => step === 'broadcast').length, 1);
});

test('an unsettled vault transaction keeps its signature and is never presented as retryable', async () => {
  const net = network({ landed: { confirmationStatus: 'processed' }, height: 'fail' });
  const flow = vaultSend(net, deposit());
  await assert.rejects(flow.run(), error => {
    assert.ok(error instanceof VaultTransactionError);
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.confirmed, false);
    assert.ok(net.onChain.has(error.signature));
    assert.doesNotMatch(friendlyError(error.message), /try again/i);
    return true;
  });
});

test('a vault transaction that reverted on-chain is reported reverted with its signature', async () => {
  const net = network({ landed: { confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6018 }] } } });
  await assert.rejects(vaultSend(net, deposit()).run(), error => error instanceof VaultTransactionError && error.outcome === 'reverted' && error.confirmed && net.onChain.has(error.signature));
});

test('a vault transaction that never landed before its blockhash expired says nothing moved and a fresh try is safe', async () => {
  const net = network({ landed: null, height: LAST_VALID + 1 });
  await assert.rejects(vaultSend(net, deposit()).run(), error => {
    assert.ok(error instanceof SolanaTransactionExpiredError);
    assert.ok(!(error instanceof VaultTransactionError), 'not the "do not repeat it" notice');
    assert.equal(error.message, SOLANA_EXPIRED_TEXT);
    assert.equal(friendlyError(error.message), SOLANA_EXPIRED_TEXT);
    return true;
  });
});

test('an RPC refusal before sending is passed through without polling', async () => {
  const net = network({ refuse: true });
  await assert.rejects(vaultSend(net, deposit()).run(), error => error instanceof SolanaSendError && error.submitted === false);
  assert.equal(net.log.includes('status'), false);
});

test('a wallet that sent by itself and lost its answer leaves an unresolved vault transaction without a signature', async () => {
  const net = network();
  const { lifetime } = deposit();
  await assert.rejects(settleSolanaVaultTransaction(net.connection, lifetime, async () => { throw new SolanaSendError('This transaction may have gone through. Check Activity or the explorer before trying again.', '', 'unknown'); }),
    error => error instanceof VaultTransactionError && error.signature === '' && error.outcome === 'unknown' && !error.confirmed);
});

test('a transport failure after a broadcast is worded calmly; meaningful verification messages are kept', async () => {
  await assert.rejects(preserveVaultTransaction('sig', async () => { throw new TypeError('fetch failed'); }), error => error instanceof VaultTransactionError && !/try again/i.test(friendlyError(error.message)) && error.signature === 'sig');
  await assert.rejects(preserveVaultTransaction('sig', async () => { throw new Error('502 Bad Gateway'); }, true), error => error instanceof VaultTransactionError && error.message === 'The transaction is confirmed, but its result could not be read yet.');
  await assert.rejects(preserveVaultTransaction('sig', async () => { throw new Error('Deployed vault configuration differs from your request.'); }, true), /differs from your request/);
});
