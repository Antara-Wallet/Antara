import test from 'node:test';
import assert from 'node:assert/strict';
import { SOLANA_SEND_UNKNOWN_TEXT, friendlyError, isNetworkError } from './friendlyError';

test('publicnode 403 body becomes a calm network sentence', () => {
  const raw = '403 : {"jsonrpc":"2.0","error":{"code":-32602,"message":"Indexed requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":"e0fb0253"}';
  assert.equal(friendlyError(raw), 'Couldn’t reach the Solana network just now. Try again in a moment.');
});
test('web3.js expiry never shows the raw signature text', () => {
  const raw = 'Signature 5DTiEnez4Urj1kdjA3wLiKoAuq3bqkEpP638Jm1RSHTcXPvxWb7xPT7eiRbQWNMioUuVWKusY8T7Zstes5fFLke1 has expired: block height exceeded.';
  // Incident 2026-10-13: this exact transaction was finalized, so it is never called failed or retryable.
  assert.equal(friendlyError(raw), SOLANA_SEND_UNKNOWN_TEXT);
});
test('a send whose confirmation wait gave up says it may have gone through, never a plain "try again"', () => {
  for (const raw of [
    // Privy 3.48 embedded signAndSendTransaction: thrown after the broadcast, when its 10 s websocket wait ends.
    'Transaction confirmation timed out',
    'Error: Transaction confirmation timed out',
    // web3.js confirmTransaction timeout strategy.
    'Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. Check signature 5DTiEnez4Urj1kdjA3wLiKoAuq3bqkEpP638Jm1RSHTcXPvxWb7xPT7eiRbQWNMioUuVWKusY8T7Zstes5fFLke1 using the Solana Explorer or CLI tools.',
    'TransactionExpiredBlockheightExceededError',
  ]) {
    const text = friendlyError(raw);
    assert.equal(text, SOLANA_SEND_UNKNOWN_TEXT, raw);
    assert.match(text, /may have gone through/);
    assert.doesNotMatch(text, /^Try again|Try again in a moment/);
  }
  assert.equal(friendlyError('Transaction confirmation failed'), 'This transaction failed on Solana. Nothing moved; network fees may have been charged.');
});
test('reads that time out are still network trouble; the send texts ANTARA writes pass through unchanged', () => {
  assert.equal(friendlyError('Request timed out'), 'Couldn’t reach the Solana network just now. Try again in a moment.');
  assert.equal(isNetworkError('TypeError: fetch failed'), true);
  assert.equal(isNetworkError('429 Too Many Requests'), true);
  assert.equal(isNetworkError('The Solana transaction failed on-chain.'), false);
  for (const text of [
    SOLANA_SEND_UNKNOWN_TEXT,
    'This transaction did not land on Solana before it expired. Nothing moved, so it is safe to try again.',
    'Solana has not confirmed this transaction yet. It may still go through.',
    'The network has not confirmed this transaction yet. It may still go through.',
    'The transaction is confirmed, but its result could not be read yet.',
    'Solana refused this transaction before sending it, so nothing moved. Review it again. Nothing was sent.',
    'This transaction took too long to approve and expired before it was sent. Review it again. Nothing was sent.',
    'Your wallet changed this transaction after you reviewed it, so ANTARA did not send it. Nothing was sent.',
  ]) assert.equal(friendlyError(text), text);
});
test('raw JSON and long dumps fall back; plain sentences pass through', () => {
  assert.equal(friendlyError('{"error":"x"}'), 'Something went wrong. Try again in a moment.');
  assert.equal(friendlyError('x'.repeat(300)), 'Something went wrong. Try again in a moment.');
  assert.equal(friendlyError('This vault has an administrator that can override multisig configuration.'), 'This vault has an administrator that can override multisig configuration.');
  assert.equal(friendlyError('User rejected the request.'), 'You cancelled the request in your wallet.');
});
