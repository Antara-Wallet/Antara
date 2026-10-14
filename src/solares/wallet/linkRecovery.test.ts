import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINK_RETRY_DELAYS_MS, SESSION_CHANGED_MESSAGE, SessionChangedError, WALLET_NOT_CONFIRMED_MESSAGE, WALLET_NOT_LINKED, WalletNotLinkedError,
  abortableSleep, accessTokenSubject, assertTokenForUser, isLinkedHere, linkedWalletsKey, linkedWalletsOf, retryUntilLinked, walletNotLinked,
} from './linkRecovery';

// Shaped like Privy's access tokens (ES256 JWT, `sub` = the Privy user id). The signature is never checked client-side.
const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims: object) => `${segment({ alg: 'ES256', typ: 'JWT' })}.${segment(claims)}.c2lnbmF0dXJl`;
const owner = 'did:privy:cmgowner0000000000000000';
const older = 'did:privy:cmgolder0000000000000000';

test('reads the token subject, and nothing from a malformed or oversized token', () => {
  assert.equal(accessTokenSubject(token({ sub: owner, sid: 's', iss: 'privy.io' })), owner);
  for (const bad of ['', 'abc', 'a.b', `${segment({})}.${segment({ sub: owner })}`, token({}), token({ sub: 42 }), token({ sub: '' }), token({ sub: 'x'.repeat(201) }),
    `${segment({})}.!!!.sig`, `${segment({})}.${'A'.repeat(8_193)}.sig`, `${segment({})}.${Buffer.from('not json').toString('base64url')}.sig`]) {
    assert.equal(accessTokenSubject(bad), null, bad.slice(0, 40));
  }
});

test('a token for another account is refused before it is sent; an unreadable one is left to the server', () => {
  assert.doesNotThrow(() => assertTokenForUser(token({ sub: owner }), owner));
  assert.throws(() => assertTokenForUser(token({ sub: older }), owner), (error: unknown) => error instanceof SessionChangedError && error.message === SESSION_CHANGED_MESSAGE);
  // No user to compare yet (signing in), no token, or no readable subject: nothing to decide here.
  assert.doesNotThrow(() => assertTokenForUser(token({ sub: older }), null));
  assert.doesNotThrow(() => assertTokenForUser(null, owner));
  assert.doesNotThrow(() => assertTokenForUser('opaque-token', owner));
});

test('recognises the server’s not-linked refusal, including the wording of servers released before the code', () => {
  const coded = walletNotLinked(403, { error: 'This wallet is not linked to the ANTARA account you are signed in with.', code: WALLET_NOT_LINKED, chain: 'solana' });
  assert.ok(coded instanceof WalletNotLinkedError);
  assert.equal(coded.chain, 'solana'); assert.equal(coded.message, 'This wallet is not linked to the ANTARA account you are signed in with.');
  const legacy = walletNotLinked(403, { error: 'The requested wallet is not linked to this session.' });
  assert.ok(legacy instanceof WalletNotLinkedError);
  assert.equal(legacy.chain, null); assert.equal(legacy.message, WALLET_NOT_CONFIRMED_MESSAGE);
  assert.equal(walletNotLinked(403, { code: WALLET_NOT_LINKED, chain: 'bitcoin', error: 'x'.repeat(301) })?.message, WALLET_NOT_CONFIRMED_MESSAGE);
  assert.equal(walletNotLinked(403, { code: WALLET_NOT_LINKED, chain: 'bitcoin' })?.chain, null);
  for (const [status, body] of [[401, { code: WALLET_NOT_LINKED }], [403, { error: 'Forbidden origin.' }], [403, null], [403, [WALLET_NOT_LINKED]], [429, { code: 'RATE_LIMITED' }]] as const) {
    assert.equal(walletNotLinked(status, body), null, JSON.stringify([status, body]));
  }
});

test('linked wallets come from Privy’s linked accounts only, in a stable order and key', () => {
  const accounts = [
    { type: 'email', address: 'someone@example.com' },
    { type: 'wallet', chainType: 'solana', address: 'Cu73KkEmbedded1111111111111111111111xsAvf' },
    { type: 'wallet', chainType: 'ethereum', address: '0x7E6c00000000000000000000000000000000F9805' },
    { type: 'wallet', chainType: 'solana', address: 'EMX22GPhantom111111111111111111111111ny5tD' },
    { type: 'wallet', chainType: 'bitcoin-segwit', address: 'bc1q' },
    { type: 'smart_wallet', address: '0xsmart' }, null,
  ];
  const linked = linkedWalletsOf(accounts);
  assert.deepEqual(linked.map(item => `${item.chain}:${item.address.slice(0, 6)}`), ['ethereum:0x7E6c', 'solana:Cu73Kk', 'solana:EMX22G']);
  assert.equal(linkedWalletsKey(linked), linkedWalletsKey(linkedWalletsOf([...accounts].reverse())));
  assert.notEqual(linkedWalletsKey(linked), linkedWalletsKey(linked.slice(1)));
  assert.equal(linkedWalletsOf(undefined).length, 0);
  // EVM addresses compare without case; Solana addresses are case-sensitive.
  assert.equal(isLinkedHere(linked, 'ethereum', '0x7e6c00000000000000000000000000000000f9805'), true);
  assert.equal(isLinkedHere(linked, 'solana', 'Cu73KkEmbedded1111111111111111111111xsAvf'), true);
  assert.equal(isLinkedHere(linked, 'solana', 'cu73kkembedded1111111111111111111111xsavf'), false);
  assert.equal(isLinkedHere(linked, 'ethereum', 'Cu73KkEmbedded1111111111111111111111xsAvf'), false);
  assert.equal(isLinkedHere(linked, 'solana', null), false);
  assert.equal(isLinkedHere(undefined, 'solana', 'Cu73KkEmbedded1111111111111111111111xsAvf'), false);
});

const notLinked = () => new WalletNotLinkedError('not linked', 'solana');
const recordSleeps = () => {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
};

test('asks again at 1.5 s, 4 s and 10 s while the wallet is not linked yet, and stops as soon as it is', async () => {
  assert.deepEqual([...LINK_RETRY_DELAYS_MS], [1_500, 4_000, 10_000]);
  const { slept, sleep } = recordSleeps();
  const attempts: number[] = [];
  const value = await retryUntilLinked(async attempt => { attempts.push(attempt); if (attempt < 2) throw notLinked(); return 'balances'; },
    { retryable: outcome => !outcome.ok && outcome.error instanceof WalletNotLinkedError, sleep });
  assert.equal(value, 'balances');
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(slept, [1_500, 4_000]);
});

test('gives up after the last wait with the last refusal, and never retries anything else', async () => {
  const { slept, sleep } = recordSleeps();
  let runs = 0;
  await assert.rejects(retryUntilLinked(async () => { runs++; throw notLinked(); }, { retryable: outcome => !outcome.ok && outcome.error instanceof WalletNotLinkedError, sleep }), WalletNotLinkedError);
  assert.equal(runs, 4); assert.deepEqual(slept, [1_500, 4_000, 10_000]);
  // A changed session, a network failure or a value that is fine are final at once.
  for (const error of [new SessionChangedError(), new TypeError('offline')]) {
    const tries = recordSleeps();
    await assert.rejects(retryUntilLinked(async () => { throw error; }, { retryable: outcome => !outcome.ok && outcome.error instanceof WalletNotLinkedError, sleep: tries.sleep }), error);
    assert.deepEqual(tries.slept, []);
  }
  // Value-based: a result that still does not list the wallet is returned as it is after the last try.
  const tries = recordSleeps();
  const last = await retryUntilLinked(async attempt => ({ listed: false, attempt }), { retryable: outcome => outcome.ok && !outcome.value.listed, sleep: tries.sleep, delays: [5, 6] });
  assert.deepEqual(last, { listed: false, attempt: 2 }); assert.deepEqual(tries.slept, [5, 6]);
});

test('stops waiting the moment the view changes (abort)', async () => {
  const controller = new AbortController();
  let runs = 0;
  const pending = retryUntilLinked(async () => { runs++; throw notLinked(); }, { retryable: () => true, signal: controller.signal, delays: [60_000] });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error('Vault view changed.'));
  await assert.rejects(pending, /Vault view changed/);
  assert.equal(runs, 1);
  await assert.rejects(abortableSleep(10, controller.signal), /Vault view changed/);
  await abortableSleep(1);
});
