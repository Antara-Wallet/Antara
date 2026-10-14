import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WALLET_NOT_CONFIRMED_MESSAGE } from '../wallet/linkRecovery';
import { readLinkedPairedAccount } from './linkedAccount';
import type { PairedAccount } from './pairedApi';

const owner = 'Cu73KkEmbedded1111111111111111111111xsAvf';
const phantom = 'EMX22GPhantom111111111111111111111111ny5tD';
const account = (...addresses: string[]): PairedAccount => ({
  mfaEnrolled: true, vaults: [],
  wallets: addresses.map(address => ({ address, embedded: address === owner, pairProblem: address === owner ? null : 'Paired vaults use your ANTARA (Privy) embedded Solana wallet.' })),
});

function harness(answers: PairedAccount[], linkedHere = true) {
  const tokens: string[] = [], slept: number[] = [];
  let reads = 0, fresh = 0;
  const run = () => readLinkedPairedAccount({
    owner, linkedHere, firstToken: 'first', signal: new AbortController().signal,
    token: async () => `fresh-${++fresh}`,
    fetchAccount: async token => { tokens.push(token); return answers[Math.min(reads++, answers.length - 1)]; },
    sleep: async ms => { slept.push(ms); },
  });
  return { run, tokens, slept, reads: () => reads };
}

test('a wallet the server lists at once is read once', async () => {
  const h = harness([account(owner, phantom)]);
  assert.deepEqual((await h.run()).wallets.map(item => item.address), [owner, phantom]);
  assert.deepEqual(h.tokens, ['first']); assert.deepEqual(h.slept, []);
});

test('a just-created ANTARA wallet the server lists late is asked again with a fresh token, then used', async () => {
  // Owner screenshot 2026-10-14: the first read listed only the Phantom login wallet.
  const h = harness([account(phantom), account(phantom), account(owner, phantom)]);
  const result = await h.run();
  assert.ok(result.wallets.some(item => item.address === owner && item.pairProblem === null));
  assert.deepEqual(h.tokens, ['first', 'fresh-1', 'fresh-2']);
  assert.deepEqual(h.slept, [1_500, 4_000]);
});

test('if the server never lists it, the view is unavailable with a reason, never "use your ANTARA wallet"', async () => {
  const h = harness([account(phantom)]);
  await assert.rejects(h.run(), new RegExp(WALLET_NOT_CONFIRMED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(h.reads(), 4); assert.deepEqual(h.slept, [1_500, 4_000, 10_000]);
});

test('a selected wallet this client does not see linked is answered from the first read, unchanged', async () => {
  const h = harness([account(phantom)], false);
  assert.deepEqual((await h.run()).wallets.map(item => item.address), [phantom]);
  assert.equal(h.reads(), 1); assert.deepEqual(h.slept, []);
});

test('a changed view or a failed read ends it at once', async () => {
  let reads = 0;
  await assert.rejects(readLinkedPairedAccount({
    owner, linkedHere: true, firstToken: 'first', signal: new AbortController().signal, token: async () => 'fresh',
    fetchAccount: async () => { reads++; return account(phantom); },
    assertCurrent: () => { throw new Error('Your account or selected wallet changed. Review this action again.'); },
    sleep: async () => {},
  }), /selected wallet changed/);
  assert.equal(reads, 1);
  await assert.rejects(readLinkedPairedAccount({
    owner, linkedHere: true, firstToken: 'first', signal: new AbortController().signal, token: async () => 'fresh',
    fetchAccount: async () => { throw new Error('The vault guardian is unavailable. Nothing was approved.'); }, sleep: async () => {},
  }), /guardian is unavailable/);
});
