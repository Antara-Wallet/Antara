import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { QuoteStep } from './model';
import { assertApprovalReceipt, sendSolanaDeposit, submitRelayDeposit } from './execution';
import { SolanaSendError } from '../wallet/solanaSend';

const step = (id: string): QuoteStep => ({ id, kind: 'transaction', items: [{ status: 'incomplete', data: {} }] });

test('approval timeout never submits a later deposit', async () => {
  const sends: string[] = [];
  await assert.rejects(submitRelayDeposit({
    steps: [step('approve'), step('deposit')], assertCanSign() {},
    async send(value) { sends.push(value.id); return value.id; },
    async confirmApproval() { throw new Error('Receipt timed out'); },
    async indexDeposit() { assert.fail('No deposit was authorized'); },
  }), /Receipt timed out/);
  assert.deepEqual(sends, ['approve']);
});

test('changed session after approval prevents the deposit signature', async () => {
  let active = true;
  const sends: string[] = [];
  await assert.rejects(submitRelayDeposit({
    steps: [step('approve'), step('deposit')], assertCanSign() { if (!active) throw new Error('Session changed'); },
    async send(value) { sends.push(value.id); return value.id; },
    async confirmApproval() { active = false; },
    async indexDeposit() { assert.fail('No deposit was authorized'); },
  }), /Session changed/);
  assert.deepEqual(sends, ['approve']);
});

test('one confirmed approval and one deposit hand off without settlement polling', async () => {
  const events: string[] = [];
  const hash = await submitRelayDeposit({
    steps: [step('approve'), step('deposit')], assertCanSign() {},
    async send(value) { events.push(value.id); return `hash:${value.id}`; },
    async confirmApproval(value) { events.push(`confirm:${value}`); },
    async indexDeposit(value) { events.push(`index:${value}`); },
  });
  assert.equal(hash, 'hash:deposit');
  assert.deepEqual(events, ['approve', 'confirm:hash:approve', 'deposit', 'index:hash:deposit']);
});

test('invalid signature sequence is rejected before touching any wallet', async () => {
  for (const ids of [['deposit', 'deposit'], ['deposit', 'approve'], ['permit'], []]) {
    await assert.rejects(submitRelayDeposit({
      steps: ids.map(step), assertCanSign() { assert.fail('No signature may be requested'); },
      async send() { assert.fail('No signature may be requested'); },
      async confirmApproval() {}, async indexDeposit() {},
    }), /Unsupported transaction sequence/);
  }
});

test('successful cancellation or replacement of approval cannot authorize the deposit', async () => {
  const sends: string[] = [];
  await assert.rejects(submitRelayDeposit({
    steps: [step('approve'), step('deposit')], assertCanSign() {},
    async send(value) { sends.push(value.id); return '0x1111'; },
    async confirmApproval(hash) { assertApprovalReceipt(hash, { status: 'success', transactionHash: '0x2222' }); },
    async indexDeposit() { assert.fail('No deposit was authorized'); },
  }), /replaced or cancelled/);
  assert.deepEqual(sends, ['approve']);
  assert.throws(() => assertApprovalReceipt('0x1111', { status: 'reverted', transactionHash: '0x1111' }), /failed on-chain/);
});

test('a Solana deposit whose answer was lost keeps its signature; a definite refusal sent nothing', async () => {
  assert.deepEqual(await sendSolanaDeposit(async () => 'sig-accepted'), { signature: 'sig-accepted' });
  // Broadcast through ANTARA's RPC, answer lost: followed under its signature (recorded, indexed, tracked).
  assert.deepEqual(await sendSolanaDeposit(async () => { throw new SolanaSendError('may have gone through', 'sig-lost', 'unknown'); }), { signature: 'sig-lost' });
  // A wallet that broadcast itself and failed: it may have been sent, but there is no signature to follow.
  const walletOwn = new SolanaSendError('may have gone through', '', 'unknown');
  assert.deepEqual(await sendSolanaDeposit(async () => { throw walletOwn; }), { error: walletOwn, maybeSent: true });
  // Refused by the RPC before sending, or not signed at all: nothing reached the network.
  const refused = new SolanaSendError('Solana refused this transaction before sending it. Nothing was sent.', 'sig-refused', false);
  assert.deepEqual(await sendSolanaDeposit(async () => { throw refused; }), { error: refused, maybeSent: false });
  const cancelled = new Error('User rejected the request.');
  assert.deepEqual(await sendSolanaDeposit(async () => { throw cancelled; }), { error: cancelled, maybeSent: false });
});
