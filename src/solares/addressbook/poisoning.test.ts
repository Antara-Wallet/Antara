import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookalike, lookalikeWarning } from './poisoning';

const SAVED = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
// Same first 4 and last 4 characters, different middle: a poisoning lookalike.
const LOOKALIKE = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJZ292j7xrsUGWBu';
const EVM_SAVED = '0x52908400098527886E0F7030069857D2E4169EE7';
const EVM_LOOKALIKE = '0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9ee7';
const candidates = [
  { label: 'Treasury', address: SAVED },
  { label: 'Exchange', address: EVM_SAVED },
];

test('an equal address is recognised, never a lookalike (Solana exact, EVM any case)', () => {
  assert.equal(lookalike(SAVED, candidates), null);
  assert.equal(lookalike(`  ${SAVED} `, candidates), null);
  assert.equal(lookalike(EVM_SAVED.toLowerCase(), candidates), null);
});

test('a lookalike sharing the first 4 and last 4 characters is flagged with its label', () => {
  assert.deepEqual(lookalike(LOOKALIKE, candidates), { label: 'Treasury', address: SAVED });
  assert.deepEqual(lookalike(EVM_LOOKALIKE, candidates), { label: 'Exchange', address: EVM_SAVED });
  assert.equal(lookalikeWarning({ label: 'Treasury' }), 'This address looks like Treasury but is different. Check every character.');
});

test('only both edges matching counts; EVM edges skip the 0x prefix', () => {
  assert.equal(lookalike('9hSRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxAAAA', candidates), null, 'start only');
  assert.equal(lookalike('Zzzz6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu', candidates), null, 'end only');
  // Shares "0x52" and the last 4 but not the first 4 hex digits.
  assert.equal(lookalike('0x52ffaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9ee7', candidates), null);
  // Solana is case-sensitive: different case at the edges is not the same characters.
  assert.equal(lookalike('9HSR6S7WPtxmTojgo6GG3k4yDPecgJZ292j7xrsUGWBu', candidates), null);
});

test('short or partial inputs are never checked', () => {
  for (const input of ['', '9hSR', '9hSRGWBu', '9hSR6S7WPtxmTojgUGWBu', '0x5290', '0x52909ee7']) assert.equal(lookalike(input, candidates), null, input);
});

test('Solana inputs are compared only with Solana candidates and EVM with EVM', () => {
  assert.equal(lookalike(LOOKALIKE, [{ label: 'Exchange', address: EVM_SAVED }]), null);
  assert.equal(lookalike(EVM_LOOKALIKE, [{ label: 'Treasury', address: SAVED }]), null);
  assert.equal(lookalike(LOOKALIKE, []), null);
});
