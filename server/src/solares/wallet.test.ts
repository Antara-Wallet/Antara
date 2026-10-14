import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_REREAD_WINDOW_MS, WALLET_NOT_LINKED, WALLET_NOT_LINKED_MESSAGE, createRereadGate, isOwnedAddress, requirePrivyUser, unlinkedChain, walletRouter, type SolaresUser,
} from './wallet.js';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { PrivyClient } from '@privy-io/node';

describe('authenticated wallet ownership boundary', () => {
  const user: SolaresUser = { id: 'did:privy:test', wallets: [{ chainType: 'ethereum', address: '0xABC', embedded: true }, { chainType: 'solana', address: 'AbcDef', embedded: false }] };
  it('does not grant another user wallet access, confuse chains, or fold Solana case', () => {
    assert.equal(isOwnedAddress(user, '0xabc', 'ethereum'), true);
    assert.equal(isOwnedAddress(user, 'AbcDef', 'solana'), true);
    assert.equal(isOwnedAddress(user, 'abcdef', 'solana'), false);
    assert.equal(isOwnedAddress(user, '0xabc', 'solana'), false);
    assert.equal(isOwnedAddress(undefined, '0xabc', 'ethereum'), false);
    assert.equal(isOwnedAddress(user, '0xFED', 'ethereum'), false);
  });
  it('fails closed without server credentials even if a request claims an identity', async () => {
    const appId = process.env.PRIVY_APP_ID, appSecret = process.env.PRIVY_APP_SECRET;
    delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET;
    let status = 0, calledNext = false;
    const response = { status(value: number) { status = value; return this; }, json() { return this; } } as unknown as Response;
    try {
      await requirePrivyUser({ headers: { authorization: 'Bearer fabricated' }, body: { userId: user.id, address: '0xABC' } } as Request, response, () => { calledNext = true; });
      assert.equal(status, 503); assert.equal(calledNext, false);
    } finally {
      if (appId !== undefined) process.env.PRIVY_APP_ID = appId;
      if (appSecret !== undefined) process.env.PRIVY_APP_SECRET = appSecret;
    }
  });
  it('records the verified token’s Privy session id, and none when it is missing or malformed', async t => {
    const appId = process.env.PRIVY_APP_ID, appSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID ||= 'test-app'; process.env.PRIVY_APP_SECRET ||= 'test-secret';
    let session: unknown = 'session-from-privy';
    t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => ({ user_id: 'did:privy:session', session_id: session }) }) }));
    t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => ({ id, linked_accounts: [] }) }));
    const response = { status() { return this; }, json() { return this; }, setHeader() { return this; } } as unknown as Response;
    const authenticate = async () => {
      const req = { headers: { authorization: 'Bearer token' } } as Request;
      let calledNext = false;
      await requirePrivyUser(req, response, () => { calledNext = true; });
      assert.equal(calledNext, true);
      return req.solaresUser!;
    };
    try {
      assert.deepEqual(await authenticate(), { id: 'did:privy:session', sessionId: 'session-from-privy', wallets: [] });
      // Vault-layer challenges are bound to the session: without a usable id, none is recorded and those routes refuse (503).
      for (const bad of [undefined, '', 42, 'x'.repeat(201)]) {
        session = bad;
        assert.equal('sessionId' in await authenticate(), false);
      }
    } finally {
      if (appId === undefined) delete process.env.PRIVY_APP_ID; else process.env.PRIVY_APP_ID = appId;
      if (appSecret === undefined) delete process.env.PRIVY_APP_SECRET; else process.env.PRIVY_APP_SECRET = appSecret;
    }
  });
});

describe('a wallet the first Privy read does not list (owner screenshot 2026-10-14)', () => {
  // A valid base58 Solana wallet: only a well-formed address can be one Privy has not listed yet.
  const solana = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
  const evm = '0x7E6c000000000000000000000000000000F98050';
  const wallet = (chain_type: 'solana' | 'ethereum', address: string) => ({ type: 'wallet', chain_type, address, connector_type: 'embedded', wallet_client_type: 'privy' });
  const record = (id: string, accounts: object[]) => ({ id, linked_accounts: accounts }) as never;
  const session = (wallets: SolaresUser['wallets']) => ({ solaresUser: { id: 'did:privy:owner', sessionId: 's1', wallets } });
  // These cases are about one request each; the per-account limit has its own test below.
  const open = () => true;

  it('answers at once, without another Privy read, when every requested wallet is linked', async () => {
    let reads = 0;
    const req = session([{ chainType: 'solana', address: solana, embedded: true }, { chainType: 'ethereum', address: evm, embedded: true }]);
    const missing = await unlinkedChain(req, [{ address: solana, chainType: 'solana' }, { address: evm.toLowerCase(), chainType: 'ethereum' }, { address: '', chainType: 'ethereum' }],
      { delayMs: 0, rereadGate: open, loadUser: async () => { reads++; return record('did:privy:owner', []); } });
    assert.equal(missing, null); assert.equal(reads, 0);
  });
  it('re-reads the same user exactly once and accepts a wallet Privy has since linked', async () => {
    const reads: string[] = [];
    const req = session([{ chainType: 'ethereum', address: evm, embedded: true }]);
    const missing = await unlinkedChain(req, [{ address: solana, chainType: 'solana' }, { address: evm, chainType: 'ethereum' }],
      { delayMs: 0, rereadGate: open, loadUser: async id => { reads.push(id); return record(id, [wallet('ethereum', evm), wallet('solana', solana)]); } });
    assert.equal(missing, null);
    assert.deepEqual(reads, ['did:privy:owner']);
    // The session id and user id are kept; only the wallet list is Privy's fresh answer.
    assert.equal(req.solaresUser.id, 'did:privy:owner'); assert.equal(req.solaresUser.sessionId, 's1');
    assert.deepEqual(req.solaresUser.wallets.map(item => item.address), [evm, solana]);
  });
  it('still refuses, naming the chain, when the re-read does not list it, belongs to another user, or fails', async () => {
    const requested = [{ address: solana, chainType: 'solana' as const }];
    let reads = 0;
    const absent = session([]);
    assert.equal(await unlinkedChain(absent, requested, { delayMs: 0, rereadGate: open, loadUser: async id => { reads++; return record(id, [wallet('solana', 'SomeOtherWallet1111111111111111111111111111')]); } }), 'solana');
    assert.equal(reads, 1, 'one re-read per request, never a loop');
    const other = session([]);
    assert.equal(await unlinkedChain(other, requested, { delayMs: 0, rereadGate: open, loadUser: async () => record('did:privy:someone-else', [wallet('solana', solana)]) }), 'solana');
    assert.deepEqual(other.solaresUser.wallets, [], 'another user’s wallets are never adopted');
    assert.equal(await unlinkedChain(session([]), requested, { delayMs: 0, rereadGate: open, loadUser: async () => { throw new Error('privy down'); } }), 'solana');
    // Solana addresses are case-sensitive: a case-folded address is a different wallet.
    assert.equal(await unlinkedChain(session([{ chainType: 'solana', address: solana, embedded: true }]), [{ address: solana.toLowerCase(), chainType: 'solana' }],
      { delayMs: 0, rereadGate: open, loadUser: async id => record(id, [wallet('solana', solana)]) }), 'solana');
    assert.equal(await unlinkedChain({}, requested, { delayMs: 0, rereadGate: open, loadUser: async id => record(id, [wallet('solana', solana)]) }), 'solana', 'no verified user, no re-read');
  });
  it('re-reads only for the race it covers: a well-formed address on a chain with no embedded wallet yet', async () => {
    let reads = 0;
    const loadUser = async (id: string) => { reads++; return record(id, [wallet('ethereum', evm), wallet('solana', solana)]); };
    // The first read already has the account's embedded wallet on that chain: any other address is simply not linked.
    assert.equal(await unlinkedChain(session([{ chainType: 'ethereum', address: evm, embedded: true }]), [{ address: '0x2222222222222222222222222222222222222222', chainType: 'ethereum' }],
      { delayMs: 0, rereadGate: open, loadUser }), 'ethereum');
    assert.equal(await unlinkedChain(session([{ chainType: 'solana', address: solana, embedded: true }]), [{ address: 'EMX22GqsGJbZAMr3uE6g6yZ7EjZz8Y1tMRu2CnZny5tD', chainType: 'solana' }],
      { delayMs: 0, rereadGate: open, loadUser }), 'solana');
    // A malformed address is never a wallet Privy is about to list.
    for (const [address, chainType] of [['not-a-wallet', 'solana'], ['0x1234', 'ethereum'], ['LinkLagOwner111111111111111111111111111111', 'solana']] as const) {
      assert.equal(await unlinkedChain(session([]), [{ address, chainType }], { delayMs: 0, rereadGate: open, loadUser }), chainType, address);
    }
    // One unlisted address outside the race refuses the whole request without a re-read.
    assert.equal(await unlinkedChain(session([{ chainType: 'ethereum', address: evm, embedded: true }]),
      [{ address: solana, chainType: 'solana' }, { address: '0x2222222222222222222222222222222222222222', chainType: 'ethereum' }], { delayMs: 0, rereadGate: open, loadUser }), 'solana');
    assert.equal(reads, 0, 'none of these asked Privy again');
    // An external (non-embedded) wallet on the chain does not count as the account's embedded wallet.
    assert.equal(await unlinkedChain(session([{ chainType: 'solana', address: 'EMX22GqsGJbZAMr3uE6g6yZ7EjZz8Y1tMRu2CnZny5tD', embedded: false }]), [{ address: solana, chainType: 'solana' }],
      { delayMs: 0, rereadGate: open, loadUser }), null);
    assert.equal(reads, 1);
  });
  it('re-reads at most once per account per window, and a refusal stands while the window is closed', async () => {
    let now = 1_000_000;
    const gate = createRereadGate(LINK_REREAD_WINDOW_MS);
    const timed: typeof gate = userId => gate(userId, now);
    let reads = 0;
    const loadUser = async (id: string) => { reads++; return record(id, []); };
    const ask = (id = 'did:privy:owner') => unlinkedChain({ solaresUser: { id, wallets: [] } }, [{ address: solana, chainType: 'solana' }], { delayMs: 0, rereadGate: timed, loadUser });
    assert.equal(await ask(), 'solana'); assert.equal(reads, 1);
    now += LINK_REREAD_WINDOW_MS - 1;
    assert.equal(await ask(), 'solana'); assert.equal(reads, 1, 'no second read inside the window');
    assert.equal(await ask('did:privy:another'), 'solana'); assert.equal(reads, 2, 'each account has its own window');
    now += 1;
    assert.equal(await ask(), 'solana'); assert.equal(reads, 3, 'allowed again once the window has passed');
    assert.equal(LINK_REREAD_WINDOW_MS, 10_000);
  });
  it('the balances route refuses with a stable code before any RPC read, and serves a wallet that was only late', async t => {
    const appId = process.env.PRIVY_APP_ID, appSecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID ||= 'test-app'; process.env.PRIVY_APP_SECRET ||= 'test-secret';
    t.after(() => {
      if (appId === undefined) delete process.env.PRIVY_APP_ID; else process.env.PRIVY_APP_ID = appId;
      if (appSecret === undefined) delete process.env.PRIVY_APP_SECRET; else process.env.PRIVY_APP_SECRET = appSecret;
    });
    let reads = 0;
    t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => ({ user_id: 'did:privy:owner', session_id: 's1' }) }) }));
    // The first read predates the Solana wallet; every later read lists it.
    t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => record(id, ++reads === 1 ? [wallet('ethereum', evm)] : [wallet('ethereum', evm), wallet('solana', solana)]) }));
    const rpc = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('no network in tests'); });
    const app = express().use('/wallet', walletRouter);
    const late = await request(app).get('/wallet/balances').query({ solana, ethereum: evm }).set('Authorization', 'Bearer token').expect(200);
    assert.equal(reads, 2);
    assert.deepEqual(late.body.balances, []);
    const before = rpc.mock.callCount();
    const refused = await request(app).get('/wallet/balances').query({ ethereum: '0x2222222222222222222222222222222222222222' }).set('Authorization', 'Bearer token').expect(403);
    assert.deepEqual(refused.body, { error: WALLET_NOT_LINKED_MESSAGE, code: WALLET_NOT_LINKED, chain: 'ethereum' });
    assert.equal(rpc.mock.callCount(), before, 'a refused wallet is never read');
    assert.equal(reads, 3, 'no re-read: the account already has its embedded EVM wallet, so this address is simply not linked');
  });
});
