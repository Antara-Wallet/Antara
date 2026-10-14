import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EIP1193Provider, RpcTransactionRequest } from 'viem';
import { assertWalletSession, guardEvmProvider } from './session';
import type { WalletSession } from './types';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const original: WalletSession = { authenticated: true, userId: 'did:privy:alice', addresses: { solana: null, ethereum: owner } };
const send: { method: 'eth_sendTransaction'; params: [RpcTransactionRequest] } = { method: 'eth_sendTransaction', params: [{ from: owner, to: other, value: '0x1' }] };
function mockProvider() {
  const state = { chain: '0x2105', accounts: [owner], sends: 0, onAccounts: () => {}, signedRequests: [] as unknown[] };
  const provider = { request: async (request: { method: string }) => {
    const { method } = request;
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_accounts') { state.onAccounts(); return state.accounts; }
    if (method === 'eth_sendTransaction' || method.startsWith('eth_sign') || method === 'personal_sign' || method === 'wallet_sendCalls') { state.sends++; state.signedRequests.push(request); return `0x${'ab'.repeat(32)}`; }
    throw new Error('Unexpected RPC');
  } } as EIP1193Provider;
  return { state, provider };
}

test('provider refuses signing through a previously acquired provider after logout, account selection or user change', async () => {
  for (const next of [
    { ...original, authenticated: false },
    { ...original, userId: 'did:privy:bob' },
    { ...original, addresses: { ...original.addresses, ethereum: other } },
  ]) {
    let live = original;
    const { provider, state } = mockProvider();
    const guarded = await guardEvmProvider(provider, 8453, owner, () => assertWalletSession(original, live));
    live = next;
    await assert.rejects(guarded.request(send), /changed/);
    assert.equal(state.sends, 0, 'no signing request reaches the provider');
  }
});

test('provider rechecks identity after asynchronous RPC preflight and rejects wrong chains and accounts', async () => {
  for (const change of ['session', 'chain', 'account']) {
    let live = original;
    const { provider, state } = mockProvider();
    const guarded = await guardEvmProvider(provider, 8453, owner, () => assertWalletSession(original, live));
    if (change === 'session') state.onAccounts = () => { live = { ...original, authenticated: false }; };
    if (change === 'chain') state.chain = '0x1';
    if (change === 'account') state.accounts = [other];
    await assert.rejects(guarded.request(send));
    assert.equal(state.sends, 0);
  }
});

test('provider passes the exact valid transaction and rejects an alternate sender', async () => {
  const { provider, state } = mockProvider();
  const guarded = await guardEvmProvider(provider, 8453, owner, () => assertWalletSession(original, original));
  assert.equal(await guarded.request(send), `0x${'ab'.repeat(32)}`);
  assert.equal(state.sends, 1);
  await assert.rejects(guarded.request({ ...send, params: [{ ...send.params[0], from: other }] }), /sender/);
  assert.equal(state.sends, 1);
});

test('message signatures cannot select another connected account or a different typed-data chain', async () => {
  const { provider, state } = mockProvider();
  state.accounts = [owner, other];
  const guarded = await guardEvmProvider(provider, 8453, owner, () => {});
  const typedData = JSON.stringify({ domain: { chainId: 8453 }, types: {}, message: {} });
  for (const request of [
    { method: 'personal_sign', params: ['0x1234', other] },
    { method: 'eth_sign', params: [other, '0x1234'] },
    { method: 'eth_signTypedData_v4', params: [other, typedData] },
    { method: 'eth_signTypedData_v4', params: [owner, JSON.stringify({ domain: { chainId: 1 } })] },
    { method: 'eth_signTypedData_v4', params: [owner, '{bad JSON'] },
    { method: 'eth_signTypedData_v4', params: [owner, JSON.stringify({ message: {} })] },
    { method: 'eth_sendTransaction', params: [{ from: owner, to: other, chainId: '0x1' }] },
    { method: 'wallet_sendCalls', params: [{ from: owner, chainId: '0x1', calls: [] }] },
  ]) await assert.rejects(guarded.request(request as never));
  assert.equal(state.sends, 0);
  await guarded.request({ method: 'personal_sign', params: ['0x1234', owner] });
  await guarded.request({ method: 'eth_signTypedData_v4', params: [owner, typedData] });
  assert.equal(state.sends, 2, 'valid selected-wallet signatures still reach the provider');
});

test('signing payload cannot change while signer checks are awaiting RPC', async () => {
  const { provider, state } = mockProvider();
  const guarded = await guardEvmProvider(provider, 8453, owner, () => {});
  const request = { method: 'eth_sendTransaction', params: [{ from: owner, to: other, value: '0x1' }] };
  state.onAccounts = () => { request.params[0].to = owner; request.params[0].value = '0xffff'; };
  await guarded.request(request as never);
  assert.deepEqual(state.signedRequests[0], { method: 'eth_sendTransaction', params: [{ from: owner, to: other, value: '0x1' }] });
});

test('raw broadcasts cannot bypass the reviewed-wallet signing boundary', async () => {
  const { provider, state } = mockProvider();
  const guarded = await guardEvmProvider(provider, 8453, owner, () => {});
  await assert.rejects(guarded.request({ method: 'eth_sendRawTransaction', params: ['0x1234'] }), /Raw transaction/);
  assert.equal(state.sends, 0);
});
