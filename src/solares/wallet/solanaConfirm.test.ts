import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SignatureStatus } from '@solana/web3.js';
import { confirmSolanaSignature, noteWalletBroadcast, type ConfirmSolanaOptions, type SolanaStatusRpc } from './solanaConfirm';

const SIGNATURE = '5DTiEnez4Urj1kdjA3wLiKoAuq3bqkEpP638Jm1RSHTcXPvxWb7xPT7eiRbQWNMioUuVWKusY8T7Zstes5fFLke1';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const LAST_VALID = 1_000;

type Step = { status?: Partial<SignatureStatus> | null | 'fail'; height?: number | 'fail' };
/** A fake HTTP RPC answering one scripted step per poll (the last step repeats), on a fake clock. */
function scripted(steps: Step[], options: { blockhashValid?: boolean | 'fail' } = {}) {
  let clock = 0, poll = 0;
  const calls = { statuses: [] as unknown[], heights: 0, blockhash: 0, sleeps: [] as number[] };
  const step = () => steps[Math.min(poll, steps.length - 1)];
  const rpc = {
    async getSignatureStatuses(signatures: string[], config?: unknown) {
      calls.statuses.push({ signatures, config });
      const { status } = step();
      if (status === 'fail') throw new TypeError('fetch failed');
      return { context: { slot: 1 }, value: [status ? { slot: 456657873, confirmations: 0, err: null, ...status } as SignatureStatus : null] };
    },
    async getBlockHeight() {
      calls.heights++;
      const { height } = step();
      if (height === 'fail') throw new Error('502 Bad Gateway: {}');
      return height ?? LAST_VALID - 100;
    },
    async isBlockhashValid() {
      calls.blockhash++;
      if (options.blockhashValid === 'fail') throw new Error('fetch failed');
      return { context: { slot: 1 }, value: options.blockhashValid ?? false };
    },
  } as unknown as SolanaStatusRpc;
  const run = (extra: Partial<ConfirmSolanaOptions> = {}) => confirmSolanaSignature({
    rpc, signature: SIGNATURE, blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID,
    now: () => clock, sleep: async ms => { calls.sleeps.push(ms); clock += ms; poll++; }, ...extra,
  });
  return { rpc, calls, run, elapsed: () => clock };
}

test('incident: a signature that is already finalized is confirmed on the first HTTP read, without any subscription', async () => {
  // publicnode's websocket never notified for this already-finalized signature; Privy then threw
  // "Transaction confirmation timed out" after the broadcast. One status read settles it.
  const fake = scripted([{ status: { confirmationStatus: 'finalized' } }]);
  assert.deepEqual(await fake.run(), { outcome: 'confirmed', slot: 456657873 });
  assert.equal(fake.calls.sleeps.length, 0);
  assert.deepEqual(fake.calls.statuses[0], { signatures: [SIGNATURE], config: { searchTransactionHistory: true } });
  assert.equal('onSignature' in fake.rpc, false);
});

test('incident: a lagging load-balanced RPC past lastValidBlockHeight is never read as "block height exceeded" once the signature appears', async () => {
  // web3.js reported this finalized Squads creation as expired. Here the status appears during the grace window.
  const fake = scripted([
    { status: null, height: LAST_VALID + 5 },
    { status: null, height: LAST_VALID + 6 },
    { status: null, height: LAST_VALID + 7 },
    { status: { confirmationStatus: 'finalized' }, height: LAST_VALID + 8 },
  ]);
  assert.equal((await fake.run()).outcome, 'confirmed');
});

test('processed is not confirmed: polling continues every 1.5 s until the target commitment', async () => {
  const fake = scripted([{ status: { confirmationStatus: 'processed' } }, { status: { confirmationStatus: 'processed' } }, { status: { confirmationStatus: 'confirmed' } }]);
  assert.equal((await fake.run()).outcome, 'confirmed');
  assert.deepEqual(fake.calls.sleeps, [1_500, 1_500]);
  const finalized = scripted([{ status: { confirmationStatus: 'confirmed' } }, { status: { confirmationStatus: 'finalized' } }]);
  assert.equal((await finalized.run({ commitment: 'finalized' })).outcome, 'confirmed');
  assert.equal(finalized.calls.sleeps.length, 1);
});

test('a transaction that landed with an error is reverted, not failed-to-send', async () => {
  const err = { InstructionError: [0, { Custom: 1 }] };
  const fake = scripted([{ status: { confirmationStatus: 'confirmed', err } }]);
  assert.deepEqual(await fake.run(), { outcome: 'reverted', err, slot: 456657873 });
});

test('transient read failures before confirmation are retried, never treated as absent', async () => {
  const fake = scripted([{ status: 'fail', height: 'fail' }, { status: 'fail' }, { status: { confirmationStatus: 'confirmed' } }]);
  assert.equal((await fake.run()).outcome, 'confirmed');
});

test('expired only after the height passed lastValidBlockHeight, a full 30 s grace of clean "absent" answers, and an invalid blockhash', async () => {
  const fake = scripted([{ status: null, height: LAST_VALID - 1 }, { status: null, height: LAST_VALID + 1 }]);
  const started = fake.elapsed();
  assert.deepEqual(await fake.run(), { outcome: 'expired' });
  assert.ok(fake.elapsed() - started >= 30_000 + 1_500, 'grace window respected');
  assert.equal(fake.calls.blockhash, 1);
});

test('never expired once seen: seen at processed, then lost past expiry, is unknown', async () => {
  const fake = scripted([{ status: { confirmationStatus: 'processed' }, height: LAST_VALID - 1 }, { status: null, height: LAST_VALID + 1 }]);
  assert.deepEqual(await fake.run(), { outcome: 'unknown', seen: true });
});

test('an RPC that cannot answer during the grace window yields unknown, never expired', async () => {
  const fake = scripted([{ status: null, height: LAST_VALID + 1 }, { status: 'fail', height: LAST_VALID + 2 }]);
  assert.deepEqual(await fake.run(), { outcome: 'unknown', seen: false });
});

test('a blockhash the RPC still calls valid is not expired (inconsistent nodes): it keeps polling, then reports unknown', async () => {
  const fake = scripted([{ status: null, height: LAST_VALID + 1 }], { blockhashValid: true });
  assert.deepEqual(await fake.run({ timeoutMs: 60_000 }), { outcome: 'unknown', seen: false });
  assert.ok(fake.calls.blockhash >= 1);
});

test('a blockhash check that fails or cannot be made proves nothing: unknown, never expired', async () => {
  const fake = scripted([{ status: null, height: LAST_VALID + 1 }], { blockhashValid: 'fail' });
  assert.deepEqual(await fake.run(), { outcome: 'unknown', seen: false });
  assert.ok(fake.calls.blockhash >= 2, 'the check is retried until the window ends');
  const noBlockhash = scripted([{ status: null, height: LAST_VALID + 1 }]);
  assert.deepEqual(await noBlockhash.run({ blockhash: null }), { outcome: 'unknown', seen: false });
  assert.equal(noBlockhash.calls.blockhash, 0);
  const noCheck = scripted([{ status: null, height: LAST_VALID + 1 }]);
  delete (noCheck.rpc as { isBlockhashValid?: unknown }).isBlockhashValid;
  assert.deepEqual(await noCheck.run(), { outcome: 'unknown', seen: false });
});

test('a signature a wallet broadcast itself is never expired: that wallet may have replaced the blockhash', async () => {
  const signature = '3Wk9zGUjLLD6hdWyuCnHxpgDLPkdmUQdV6hHfbUqoyRJ9GGWGnnWnNGo1wQx1ns6LZmSZDY6nxnTPa7f5eSFN1zf';
  noteWalletBroadcast(signature);
  const fake = scripted([{ status: null, height: LAST_VALID + 50 }]);
  assert.deepEqual(await fake.run({ signature, timeoutMs: 10_000 }), { outcome: 'unknown', seen: false });
  assert.equal(fake.calls.heights, 0, 'the lifetime ANTARA built is ignored');
  assert.equal(fake.calls.blockhash, 0);
  const landed = scripted([{ status: { confirmationStatus: 'confirmed' } }]);
  assert.equal((await landed.run({ signature })).outcome, 'confirmed');
});

test('without lastValidBlockHeight a transaction is never reported expired; the poll ends as unknown', async () => {
  const fake = scripted([{ status: null }]);
  assert.deepEqual(await fake.run({ lastValidBlockHeight: null, timeoutMs: 10_000 }), { outcome: 'unknown', seen: false });
  assert.equal(fake.calls.heights, 0);
});

test('a hanging read counts as unanswered instead of stalling the poll', async () => {
  let reads = 0;
  const rpc = {
    getSignatureStatuses: () => ++reads === 1 ? new Promise(() => undefined) : Promise.resolve({ context: { slot: 1 }, value: [{ slot: 9, confirmations: null, err: null, confirmationStatus: 'finalized' }] }),
    getBlockHeight: async () => 1,
  } as unknown as SolanaStatusRpc;
  const result = await confirmSolanaSignature({ rpc, signature: SIGNATURE, lastValidBlockHeight: LAST_VALID, readTimeoutMs: 5, sleep: async () => undefined });
  assert.deepEqual(result, { outcome: 'confirmed', slot: 9 });
});

test('an aborted confirmation stops polling', async () => {
  const controller = new AbortController();
  const fake = scripted([{ status: null }]);
  const pending = fake.run({ signal: controller.signal, sleep: async () => { controller.abort(); } });
  await assert.rejects(pending, error => (error as { name?: string }).name === 'AbortError');
});
