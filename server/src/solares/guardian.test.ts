import { SOLANA_GENESIS } from '../../../src/solares/wallet/solanaNetwork';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARDIAN_ENV, GUARDIAN_RATE_DEFAULTS, GuardianError, SOLANA_CAIP2, VOTE_PENDING_MS, createGuardianSigner, createPairedVaultGuardian, guardianRateLimitsFromEnv,
  normaliseAuthorizationPublicKey, readGuardianConfig, readReleaseSnapshot, solanaJsonRpc,
  type GuardianKeyQuorumInfo, type GuardianPrivyClient, type GuardianSendInput, type GuardianWalletInfo, type SolanaRpc,
} from './guardian.js';
import { usageInWindow, type LinkedSolanaWallet, type PrivyUserFacts } from './vaultPolicy.js';
import { VAULT_STORE_FILE, createVaultStore } from './vaultStore.js';
import { assertGuardianApproveTransaction, pairedVaultAddresses, type RawSolanaAccount } from '../../../src/solares/paired/solanaDecode';
import {
  guardianTransactionVariants, multisigAccount, newWallet, pairedKeys, proposalAccount, recentBlockhash, tokenAccount, usdcAta, vaultTransactionAccount,
} from '../../../src/solares/paired/testFixtures';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const SIG = '5'.repeat(88);
const POLICY = 'policyid0000000000000001';
const SIGNER = 'quorumsigner000000000001';
const OWNER = 'quorumowner0000000000001';
const WALLET_ID = 'walletid0000000000000001';
function p256Key() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}
function p256Public() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}
const ADMIN_PUBLIC = p256Public();
/** Distinct, well-formed signatures: the first is SIG. */
const signatureFor = (n: number) => n === 0 ? SIG : `${'6'.repeat(87)}${'123456789'[n % 9]}`;
function linkedWallet(address: string, extra: Partial<LinkedSolanaWallet> = {}): LinkedSolanaWallet {
  return { address, embedded: true, delegated: false, imported: false, userCanSign: true, ...extra };
}
function guardianEnv(guardian: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [GUARDIAN_ENV.authorizationKey]: p256Key(), [GUARDIAN_ENV.walletId]: WALLET_ID, [GUARDIAN_ENV.address]: guardian,
    [GUARDIAN_ENV.policyId]: POLICY, [GUARDIAN_ENV.signerId]: SIGNER, [GUARDIAN_ENV.ownerQuorumId]: OWNER, ...extra,
  };
}
interface FakePrivyOptions {
  wallet?: Partial<GuardianWalletInfo>;
  signerQuorum?: (server: string) => Partial<GuardianKeyQuorumInfo>;
  ownerQuorum?: (server: string) => Partial<GuardianKeyQuorumInfo>;
  hash?: string;
}
function fakePrivy(guardian: string, serverPublicKey: string, options: FakePrivyOptions = {}) {
  const sends: Array<{ walletId: string; input: GuardianSendInput }> = [];
  const lookups: string[] = [];
  const state = {
    wallet: {
      address: guardian, chain_type: 'solana', owner_id: OWNER, policy_ids: [POLICY],
      additional_signers: [{ signer_id: SIGNER, override_policy_ids: [POLICY] }], exported_at: null, imported_at: null, archived_at: null, ...options.wallet,
    } as Partial<GuardianWalletInfo>,
    signerQuorum: { id: SIGNER, authorization_keys: [{ public_key: serverPublicKey }], authorization_threshold: 1, user_ids: null, ...options.signerQuorum?.(serverPublicKey) } as GuardianKeyQuorumInfo,
    ownerQuorum: { id: OWNER, authorization_keys: [{ public_key: serverPublicKey }, { public_key: ADMIN_PUBLIC }], authorization_threshold: 2, user_ids: null, ...options.ownerQuorum?.(serverPublicKey) } as GuardianKeyQuorumInfo,
  };
  const client: GuardianPrivyClient = {
    async getWallet(walletId) { lookups.push(walletId); return { id: walletId, ...state.wallet } as GuardianWalletInfo; },
    async getKeyQuorum(id) {
      if (id === SIGNER) return state.signerQuorum;
      if (id === OWNER) return state.ownerQuorum;
      throw new Error('not found');
    },
    async signAndSendTransaction(walletId, input) { sends.push({ walletId, input }); return { hash: options.hash ?? signatureFor(sends.length - 1) }; },
  };
  return { client, sends, lookups, state };
}
function signerFor(guardian: string, options: FakePrivyOptions & { build?: () => Uint8Array; blockhash?: () => Promise<string>; now?: () => number; ttl?: number } = {}) {
  const config = readGuardianConfig(guardianEnv(guardian));
  const privy = fakePrivy(guardian, config.serverPublicKey, options);
  const signer = createGuardianSigner({
    config, client: privy.client, latestBlockhash: options.blockhash ?? (async () => recentBlockhash()), buildTransaction: options.build, now: options.now, bindingTtlMs: options.ttl,
  });
  return { ...privy, config, signer };
}
async function rejectsWith(promise: Promise<unknown>, status: number, pattern?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GuardianError, `expected GuardianError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe('guardian configuration', () => {
  it('fails closed when anything is missing, naming variables but never echoing values', () => {
    const keys = pairedKeys();
    const env = guardianEnv(keys.guardian);
    assert.throws(() => readGuardianConfig({}), (error: unknown) => error instanceof GuardianError && error.status === 503 && /ANTARA_GUARDIAN_AUTH_KEY/.test(error.message));
    for (const name of Object.values(GUARDIAN_ENV)) {
      assert.throws(() => readGuardianConfig({ ...env, [name]: '' }), new RegExp(name));
    }
    const bogus = Buffer.from('not a pkcs8 key at all, just bytes').toString('base64');
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.authorizationKey]: bogus }), (error: unknown) => error instanceof Error && !error.message.includes(bogus) && /PKCS#8 P-256/.test(error.message));
    const ed = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.authorizationKey]: ed }), /P-256/);
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.address]: keys.vault }), /Solana wallet address/);
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.walletId]: 'bad id!' }), /malformed/);
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.ownerQuorumId]: 'bad id!' }), /malformed/);
    assert.throws(() => readGuardianConfig({ ...env, [GUARDIAN_ENV.ownerQuorumId]: SIGNER }), /must be different/);
  });
  it('accepts the Privy wallet-auth prefix, derives the public server key and selects the CAIP-2 chain from SOLANA_CLUSTER', () => {
    const keys = pairedKeys();
    const env = guardianEnv(keys.guardian);
    const config = readGuardianConfig({ ...env, [GUARDIAN_ENV.authorizationKey]: `wallet-auth:${env[GUARDIAN_ENV.authorizationKey]}` });
    assert.equal(config.authorizationKey, env[GUARDIAN_ENV.authorizationKey]);
    assert.equal(normaliseAuthorizationPublicKey(config.serverPublicKey), config.serverPublicKey);
    assert.notEqual(config.serverPublicKey, config.authorizationKey);
    assert.equal(config.ownerQuorumId, OWNER);
    assert.equal(config.caip2, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    assert.equal(readGuardianConfig({ ...env, SOLANA_CLUSTER: 'devnet' }).caip2, SOLANA_CAIP2.devnet);
  });
  it('reads the anti-abuse vote-count ceilings from the environment and refuses malformed overrides instead of falling back', () => {
    // Owner decision 2026-10-13: far above normal use (they protect G's fee SOL, never cap value).
    assert.deepEqual(GUARDIAN_RATE_DEFAULTS, { perHour: 2_000, perUserPerHour: 120, perUserPerDay: 2_000 });
    assert.deepEqual(guardianRateLimitsFromEnv({}), { ...GUARDIAN_RATE_DEFAULTS });
    assert.deepEqual(guardianRateLimitsFromEnv({ ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR: '3', ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY: '10' }), { perHour: 2_000, perUserPerHour: 3, perUserPerDay: 10 });
    assert.deepEqual(guardianRateLimitsFromEnv({ ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR: '10000', ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY: '100000' }), { perHour: 2_000, perUserPerHour: 10_000, perUserPerDay: 100_000 });
    for (const bad of ['0', '1.5', 'abc', '-1', '100001', '1000000']) {
      assert.throws(() => guardianRateLimitsFromEnv({ ANTARA_GUARDIAN_MAX_APPROVALS_PER_HOUR: bad }), (error: unknown) => error instanceof GuardianError && error.status === 503);
    }
    assert.throws(() => guardianRateLimitsFromEnv({ ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR: '30', ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY: '20' }), /cannot exceed/);
  });
  it('normalises Privy authorization public keys whether wrapped, PEM-armoured or plain', () => {
    const key = p256Public();
    assert.equal(normaliseAuthorizationPublicKey(key), key);
    assert.equal(normaliseAuthorizationPublicKey(`${key.slice(0, 64)}\n${key.slice(64)}`), key);
    assert.equal(normaliseAuthorizationPublicKey(`-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----\n`), key);
    assert.equal(normaliseAuthorizationPublicKey('not-a-key'), null);
    assert.equal(normaliseAuthorizationPublicKey(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), null);
    assert.equal(normaliseAuthorizationPublicKey(undefined), null);
  });
});

describe('guardian signer', () => {
  it('signs and sends only its own server-built proposal_approve, as fee payer, with the authorization key', async () => {
    const keys = pairedKeys();
    const { signer, sends, config } = signerFor(keys.guardian);
    const result = await signer.approve({ multisig: keys.multisig, transactionIndex: '3' });
    assert.equal(result.signature, SIG);
    assert.equal(sends.length, 1);
    const [{ walletId, input }] = sends;
    assert.equal(walletId, WALLET_ID);
    assert.equal(input.caip2, SOLANA_CAIP2['mainnet-beta']);
    assert.equal(input.authorizationKey, config.authorizationKey);
    assert.match(input.idempotencyKey, /^antara-g-[0-9a-f]{40}$/);
    assert.doesNotThrow(() => assertGuardianApproveTransaction(input.transaction, { multisig: keys.multisig, transactionIndex: 3n, guardian: keys.guardian }));
  });
  it('refuses to sign anything other than its own proposal_approve, even from a compromised builder', async () => {
    const keys = pairedKeys();
    const { refused } = guardianTransactionVariants({ multisig: keys.multisig, transactionIndex: 3n, guardian: keys.guardian, recentBlockhash: recentBlockhash() });
    for (const [name, bytes] of Object.entries(refused)) {
      const { signer, sends } = signerFor(keys.guardian, { build: () => bytes });
      await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '3' }), 403, /refused to sign/);
      assert.equal(sends.length, 0, `${name} must never reach Privy`);
    }
    // A genuine approval for a different proposal is also refused.
    const other = guardianTransactionVariants({ multisig: keys.multisig, transactionIndex: 4n, guardian: keys.guardian, recentBlockhash: recentBlockhash() }).valid;
    const { signer, sends } = signerFor(keys.guardian, { build: () => other });
    await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '3' }), 403);
    assert.equal(sends.length, 0);
  });
  it('verifies the exact Privy wallet binding before signing and retries it after a failure', async () => {
    const keys = pairedKeys();
    const bad: Array<Partial<GuardianWalletInfo>> = [
      { address: newWallet() }, { chain_type: 'ethereum' }, { exported_at: 1 }, { imported_at: 1 }, { archived_at: 1 }, { owner_id: null },
      { owner_id: 'quorumother0000000000001' }, { policy_ids: [] }, { policy_ids: [POLICY, 'policyextra000000000001'] }, { additional_signers: [] },
      { additional_signers: [{ signer_id: SIGNER, override_policy_ids: ['otherpolicy000000000001'] }] },
      { additional_signers: [{ signer_id: SIGNER }] },
      { additional_signers: [{ signer_id: SIGNER, override_policy_ids: [POLICY, 'policyextra000000000001'] }] },
      { additional_signers: [{ signer_id: SIGNER, override_policy_ids: [POLICY] }, { signer_id: 'quorumextra000000000001', override_policy_ids: [POLICY] }] },
    ];
    for (const wallet of bad) {
      const { signer, sends } = signerFor(keys.guardian, { wallet });
      await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503);
      assert.equal(sends.length, 0, JSON.stringify(wallet));
    }
    const { signer, sends, lookups, client } = signerFor(keys.guardian);
    const real = client.getWallet;
    client.getWallet = async () => { throw new Error('network'); };
    await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503, /could not be verified/);
    client.getWallet = real;
    await signer.approve({ multisig: keys.multisig, transactionIndex: '1' });
    await signer.approve({ multisig: keys.multisig, transactionIndex: '2' });
    assert.equal(lookups.length, 1, 'a verified binding is cached');
    assert.equal(sends.length, 2);
  });
  it('refuses a signer quorum the server key could have edited, and an owner quorum that is not the provisioned 2-of-2', async () => {
    const keys = pairedKeys();
    const extra = p256Public();
    const cases: FakePrivyOptions[] = [
      { signerQuorum: server => ({ authorization_keys: [{ public_key: server }, { public_key: extra }] }) },
      { signerQuorum: () => ({ authorization_keys: [{ public_key: extra }] }) },
      { signerQuorum: () => ({ authorization_threshold: 2 }) },
      { signerQuorum: () => ({ user_ids: ['did:privy:mallory'] }) },
      { signerQuorum: () => ({ key_quorum_ids: ['quorumnested00000000001'] }) },
      { signerQuorum: () => ({ authorization_keys: [{ public_key: 'not-a-key' }] }) },
      { signerQuorum: () => ({ id: 'quorumother0000000000001' }) },
      { ownerQuorum: () => ({ authorization_threshold: 1 }) },
      { ownerQuorum: () => ({ authorization_keys: [{ public_key: ADMIN_PUBLIC }, { public_key: extra }] }) },
      { ownerQuorum: server => ({ authorization_keys: [{ public_key: server }, { public_key: ADMIN_PUBLIC }, { public_key: extra }] }) },
      { ownerQuorum: server => ({ authorization_keys: [{ public_key: server }, { public_key: server }] }) },
      { ownerQuorum: () => ({ user_ids: ['did:privy:mallory'] }) },
    ];
    for (const options of cases) {
      const { signer, sends } = signerFor(keys.guardian, options);
      await rejectsWith(signer.verify(), 503, /key quorum/);
      await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503);
      assert.equal(sends.length, 0);
    }
    // Privy may return the same key line-wrapped; that still verifies.
    const wrapped = signerFor(keys.guardian, { signerQuorum: server => ({ authorization_keys: [{ public_key: `${server.slice(0, 64)}\n${server.slice(64)}` }] }) });
    await wrapped.signer.verify();
    const failing = signerFor(keys.guardian);
    failing.client.getKeyQuorum = async () => { throw new Error('network'); };
    await rejectsWith(failing.signer.verify(), 503, /could not be verified/);
  });
  it('re-checks the binding after its time-to-live and never caches a failure', async () => {
    const keys = pairedKeys();
    let clock = NOW;
    const { signer, lookups, sends, state } = signerFor(keys.guardian, { now: () => clock, ttl: 1_000 });
    await signer.verify(); await signer.verify();
    assert.equal(lookups.length, 1);
    clock += 999; await signer.verify();
    assert.equal(lookups.length, 1);
    clock += 1; state.wallet.policy_ids = [];
    await rejectsWith(signer.verify(), 503, /signing policy/);
    await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503);
    assert.equal(lookups.length, 3, 'a failure is re-checked on the next call');
    assert.equal(sends.length, 0);
    state.wallet.policy_ids = [POLICY];
    await signer.approve({ multisig: keys.multisig, transactionIndex: '1' });
    assert.equal(sends.length, 1);
  });
  it('rejects malformed requests, RPC failures and malformed Privy responses without signing', async () => {
    const keys = pairedKeys();
    const { signer, sends, lookups } = signerFor(keys.guardian);
    await rejectsWith(signer.approve({ multisig: 'abc', transactionIndex: '1' }), 400);
    await rejectsWith(signer.approve({ multisig: keys.multisig, transactionIndex: '0' }), 400);
    assert.equal(lookups.length, 0); assert.equal(sends.length, 0);
    const failing = signerFor(keys.guardian, { blockhash: async () => { throw new Error('rpc down'); } });
    await rejectsWith(failing.signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503, /network/);
    assert.equal(failing.sends.length, 0);
    const invalid = signerFor(keys.guardian, { hash: 'not-a-signature' });
    await rejectsWith(invalid.signer.approve({ multisig: keys.multisig, transactionIndex: '1' }), 503, /invalid transaction signature/);
  });
});

describe('Solana JSON-RPC reads', () => {
  const respond = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
  it('decodes base64 accounts and reports RPC errors', async () => {
    const keys = pairedKeys();
    const account = multisigAccount(keys);
    const rpc = solanaJsonRpc('https://rpc.example.test', { fetch: respond({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [{ owner: account.owner, data: [Buffer.from(account.data).toString('base64'), 'base64'], lamports: 1 }, null] } }) });
    const [read, missing] = await rpc.accounts([keys.multisig, keys.vault]);
    assert.deepEqual(read, account); assert.equal(missing, null);
    await assert.rejects(rpc.accounts([keys.multisig]), /unexpected account list/);
    await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: respond({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }) }).latestBlockhash(), /error/);
    await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: respond({}, false) }).genesisHash(), /failed/);
    await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: respond({ result: 'x'.repeat(2_100_000) }) }).genesisHash(), /too large/);
  });
  it('reads a SOL balance and the live rent-exempt minimum, refusing malformed answers', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const answer = (result: unknown) => (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      calls.push({ method: body.method, params: body.params });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    }) as unknown as typeof fetch;
    const address = newWallet();
    assert.equal(await solanaJsonRpc('https://rpc.example.test', { fetch: answer({ context: { slot: 1 }, value: 650_240 }) }).balance!(address), 650_240n);
    assert.deepEqual(calls.at(-1), { method: 'getBalance', params: [address, { commitment: 'confirmed' }] });
    assert.equal(await solanaJsonRpc('https://rpc.example.test', { fetch: answer(650_240) }).rentExemptMinimum!(0), 650_240n);
    assert.deepEqual(calls.at(-1), { method: 'getMinimumBalanceForRentExemption', params: [0, { commitment: 'confirmed' }] });
    for (const bad of [{ value: -1 }, { value: 1.5 }, { value: '5' }, { value: 2 ** 53 }, {}]) {
      await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: answer(bad) }).balance!(address), /unexpected balance/);
    }
    for (const bad of [0, -1, 1.5, '650240', null]) {
      await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: answer(bad) }).rentExemptMinimum!(0), /unexpected minimum/);
    }
    await assert.rejects(solanaJsonRpc('https://rpc.example.test', { fetch: answer(1) }).balance!('not-an-address'), /Invalid/);
  });
  it('adds the deposit address balance and the rent minimum to a release snapshot, as null when unreadable', async () => {
    const keys = pairedKeys();
    const base = { genesisHash: async () => SOLANA_GENESIS['mainnet-beta'], accounts: async (a: string[]) => a.map(() => null), countSpendingLimits: async () => 0, latestBlockhash: async () => recentBlockhash() };
    const read: string[] = [];
    const snapshot = await readReleaseSnapshot({ ...base, balance: async address => { read.push(address); return 7n; }, rentExemptMinimum: async () => 650_240n }, 'mainnet-beta', { multisig: keys.multisig, transactionIndex: '1' });
    assert.deepEqual(read, [keys.vault]);
    assert.equal(snapshot.vaultLamports, 7n); assert.equal(snapshot.rentExemptMinimum, 650_240n);
    const failing = await readReleaseSnapshot({ ...base, balance: async () => { throw new Error('rpc down'); }, rentExemptMinimum: async () => { throw new Error('rpc down'); } }, 'mainnet-beta', { multisig: keys.multisig, transactionIndex: '1' });
    assert.equal(failing.vaultLamports, null); assert.equal(failing.rentExemptMinimum, null);
    const without = await readReleaseSnapshot(base, 'mainnet-beta', { multisig: keys.multisig, transactionIndex: '1' });
    assert.equal(without.vaultLamports, null); assert.equal(without.rentExemptMinimum, null);
  });
  it('refuses an RPC that serves another cluster', async () => {
    const keys = pairedKeys();
    const rpc: SolanaRpc = { genesisHash: async () => SOLANA_GENESIS.devnet, accounts: async a => a.map(() => null), countSpendingLimits: async () => 0, latestBlockhash: async () => recentBlockhash() };
    await assert.rejects(readReleaseSnapshot(rpc, 'mainnet-beta', { multisig: keys.multisig, transactionIndex: '1' }), /different cluster/);
  });
});

describe('paired-vault guardian service', () => {
  function service(options: { usdc?: boolean; maxApprovalsPerHour?: number; maxApprovalsPerUserPerHour?: number; failSend?: boolean; wallet?: Partial<GuardianWalletInfo> } = {}) {
    const keys = pairedKeys();
    const dir = mkdtempSync(join(tmpdir(), 'antara-guardian-'));
    const file = join(dir, VAULT_STORE_FILE);
    const chain = new Map<string, RawSolanaAccount | null>();
    const addresses = (index: bigint) => pairedVaultAddresses(keys.multisig, index);
    const setProposal = (index: bigint, approved: string[], status: 'Active' | 'Approved' = 'Active', release = options.usdc ? { kind: 'usdc' as const, to: keys.user, amount: 20_000_000n } : { kind: 'sol' as const, to: keys.user, lamports: 300_000_000n }) => {
      chain.set(keys.multisig, multisigAccount(keys, { transactionIndex: index > 3n ? index : 3n }));
      chain.set(addresses(index).proposal!, proposalAccount(keys, { index, approved, status }));
      chain.set(addresses(index).transaction!, vaultTransactionAccount(keys, { index, instructions: [release] }));
    };
    chain.set(keys.multisig, multisigAccount(keys, { transactionIndex: 3n }));
    chain.set(usdcAta(keys.user), tokenAccount({ address: usdcAta(keys.user), owner: keys.user }));
    // SOL at addresses (the vault deposit address holds 1,000 SOL unless a test sets it) and the live rent minimum.
    const lamports = new Map<string, bigint>([[keys.vault, 1_000_000_000_000n]]);
    const balanceReads: string[] = [];
    const rpc: SolanaRpc = {
      genesisHash: async () => SOLANA_GENESIS['mainnet-beta'],
      accounts: async list => list.map(address => chain.get(address) ?? null),
      countSpendingLimits: async () => 0,
      latestBlockhash: async () => recentBlockhash(),
      balance: async address => { balanceReads.push(address); return lamports.get(address) ?? 0n; },
      rentExemptMinimum: async size => { assert.equal(size, 0); return 650_240n; },
    };
    const env = guardianEnv(keys.guardian);
    const config = readGuardianConfig(env);
    const privy = fakePrivy(keys.guardian, config.serverPublicKey, { wallet: options.wallet });
    if (options.failSend) privy.client.signAndSendTransaction = async () => { throw new Error('policy denied'); };
    const user: PrivyUserFacts = { id: 'did:privy:alice', solanaWallets: [linkedWallet(keys.user)] };
    const audits: unknown[] = [];
    const store = createVaultStore(file);
    let clock = NOW;
    const guardian = createPairedVaultGuardian({
      guardian: createGuardianSigner({ config, client: privy.client, latestBlockhash: rpc.latestBlockhash }),
      rpc, cluster: 'mainnet-beta', store, now: () => clock,
      loadUser: async id => {
        if (id === user.id) return user;
        if (id === 'did:privy:bob') return { id, solanaWallets: [linkedWallet(newWallet())] };
        throw new Error('unknown user');
      },
      audit: event => audits.push(event), maxApprovalsPerHour: options.maxApprovalsPerHour, maxApprovalsPerUserPerHour: options.maxApprovalsPerUserPerHour,
    });
    const record = () => ({ privyUserId: user.id, user: keys.user, multisig: keys.multisig, guardian: keys.guardian, vault: keys.vault, createdAt: new Date(NOW).toISOString() });
    /** This vault's reserved SOL and USDC in the last 24 hours (raw text). */
    const used = () => ({
      SOL: usageInWindow(store.ledger(), { privyUserId: user.id, multisig: keys.multisig }, 'SOL', clock).toString(),
      USDC: usageInWindow(store.ledger(), { privyUserId: user.id, multisig: keys.multisig }, 'USDC', clock).toString(),
    });
    return {
      keys, file, chain, lamports, balanceReads, setProposal, privy, user, guardian, store, audits, record, used, authKey: env[GUARDIAN_ENV.authorizationKey]!,
      advance: (ms: number) => { clock += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('registers, approves, records the ledger and answers repeats idempotently', async () => {
    const s = service();
    try {
      assert.equal((await s.guardian.config()).guardian, s.keys.guardian);
      assert.equal('limits' in (await s.guardian.config()), false, 'no server-wide release limits are published');
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 409, /not registered/);
      assert.equal((await s.guardian.register(s.user.id, { multisig: s.keys.multisig })).status, 'registered');
      assert.equal((await s.guardian.register(s.user.id, { multisig: s.keys.multisig })).status, 'already-registered');
      assert.deepEqual(s.guardian.vaults(s.user.id).vaults.map(item => [item.multisig, item.vault, item.user]), [[s.keys.multisig, s.keys.vault, s.keys.user]]);
      assert.deepEqual(s.guardian.vaults('did:privy:bob').vaults, []);
      s.setProposal(1n, [s.keys.user]);
      const approved = await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' });
      assert.deepEqual(approved, { status: 'approved', signature: SIG, asset: 'SOL', amountRaw: '300000000', recipient: s.keys.user });
      assert.equal(s.privy.sends.length, 1);
      assert.equal(s.store.ledgerEntry(s.keys.multisig, '1')?.signature, SIG);
      assert.deepEqual(s.used(), { SOL: '300000000', USDC: '0' });
      s.setProposal(1n, [s.keys.user, s.keys.guardian], 'Approved');
      assert.deepEqual(await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), { status: 'already-approved' });
      assert.equal(s.privy.sends.length, 1, 'no second vote');
    } finally { s.cleanup(); }
  });

  it('answers "pending" while a recorded vote may still land, then re-signs once its blockhash has expired', async () => {
    const s = service();
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.setProposal(1n, [s.keys.user]);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'approved');
      s.advance(VOTE_PENDING_MS - 1);
      assert.deepEqual(await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), { status: 'pending', signature: SIG });
      assert.equal(s.privy.sends.length, 1, 'no second vote inside the blockhash lifetime');
      s.advance(1);
      const again = await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' });
      assert.equal(again.status, 'approved');
      assert.equal(s.privy.sends.length, 2, 'the first vote expired without landing, so G votes again');
      assert.equal(s.store.ledgerEntry(s.keys.multisig, '1')?.signature, signatureFor(1));
      assert.deepEqual(s.used(), { SOL: '300000000', USDC: '0' }, 'a re-vote is not counted twice');
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'pending');
    } finally { s.cleanup(); }
  });

  it('applies no server cap: large releases and many releases in a day are all approved', async () => {
    const s = service();
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      // Previously refused: above 0.5 SOL per release and above 2 SOL per 24 hours.
      for (const index of [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]) {
        s.setProposal(index, [s.keys.user], 'Active', { kind: 'sol', to: s.keys.user, lamports: 25_000_000_000n });
        assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: index.toString() })).status, 'approved');
      }
      assert.equal(s.privy.sends.length, 8);
      assert.deepEqual(s.used(), { SOL: '200000000000', USDC: '0' });
    } finally { s.cleanup(); }
  });

  it('reads the vault balance fresh and refuses a SOL release that would leave less than Solana’s minimum, reserving nothing', async () => {
    const s = service();
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.lamports.set(s.keys.vault, 300_100_000n);
      s.setProposal(1n, [s.keys.user]);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 409, /would leave 0\.0001 SOL in the vault, below Solana’s 0\.00065024 SOL account minimum/);
      assert.equal(s.privy.sends.length, 0, 'no vote is signed');
      assert.equal(s.store.ledgerEntry(s.keys.multisig, '1'), null, 'a refused release reserves nothing');
      assert.ok(s.balanceReads.includes(s.keys.vault), 'the deposit address balance is read for the vote');
      // Releasing everything, or leaving at least the minimum, is approved.
      s.lamports.set(s.keys.vault, 300_000_000n);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'approved');
      s.lamports.set(s.keys.vault, 300_650_240n);
      s.setProposal(2n, [s.keys.user]);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '2' })).status, 'approved');
      // More than the vault holds cannot execute either.
      s.setProposal(3n, [s.keys.user], 'Active', { kind: 'sol', to: s.keys.user, lamports: 400_000_000n });
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '3' }), 409, /less than this release/);
      assert.equal(s.privy.sends.length, 2);
    } finally { s.cleanup(); }
  });

  it('approves USDC from a vault that holds no SOL, and a SOL release of the whole balance', async () => {
    const s = service({ usdc: true });
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.lamports.delete(s.keys.vault);
      s.setProposal(1n, [s.keys.user]);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'approved', 'USDC does not depend on the SOL balance');
      s.lamports.set(s.keys.vault, 1_000n);
      s.setProposal(2n, [s.keys.user], 'Active', { kind: 'sol', to: s.keys.user, lamports: 1_000n });
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '2' })).status, 'approved', 'a tiny vault emptied completely');
    } finally { s.cleanup(); }
  });

  it('caps new votes per account without blocking a retry of an existing reservation', async () => {
    const s = service({ maxApprovalsPerUserPerHour: 2 });
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      for (const index of [1n, 2n]) {
        s.setProposal(index, [s.keys.user], 'Active', { kind: 'sol', to: s.keys.user, lamports: 10_000_000n });
        assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: index.toString() })).status, 'approved');
      }
      s.setProposal(3n, [s.keys.user], 'Active', { kind: 'sol', to: s.keys.user, lamports: 10_000_000n });
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '3' }), 429, /many vault releases/);
      assert.equal(s.store.ledgerEntry(s.keys.multisig, '3'), null, 'a refused request reserves nothing');
      assert.equal(s.privy.sends.length, 2);
      s.advance(VOTE_PENDING_MS);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'approved', 'a retry is not a new vote request');
      assert.equal(s.privy.sends.length, 3);
      s.advance(60 * 60 * 1000);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '3' })).status, 'approved', 'the hourly window rolls over');
    } finally { s.cleanup(); }
  });

  it('denies with unreadable storage and keeps a failed signing attempt reserved', async () => {
    const s = service({ failSend: true });
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.setProposal(1n, [s.keys.user]);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 503, /stays reserved/);
      assert.deepEqual(s.used(), { SOL: '300000000', USDC: '0' });
      writeFileSync(s.file, '{"version":1,');
      s.setProposal(2n, [s.keys.user]);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '2' }), 503, /storage/);
      assert.throws(() => s.guardian.vaults(s.user.id), (error: unknown) => error instanceof GuardianError && error.status === 503);
      await rejectsWith(s.guardian.config(), 503, /storage/);
    } finally { s.cleanup(); }
  });

  it('refuses config, registration and approval when the guardian binding fails, reserving nothing', async () => {
    for (const wallet of [{ address: newWallet() }, { policy_ids: [] }] as Array<Partial<GuardianWalletInfo>>) {
      const s = service({ wallet });
      try {
        await rejectsWith(s.guardian.config(), 503);
        await rejectsWith(s.guardian.register(s.user.id, { multisig: s.keys.multisig }), 503);
        assert.equal(s.store.getVault(s.keys.multisig), null, 'no vault is registered, so no deposit address is shown');
        s.store.registerVault(s.record());
        s.setProposal(1n, [s.keys.user]);
        await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 503);
        assert.deepEqual(s.store.ledger(), [], 'a binding failure never reserves a vote');
        assert.equal(s.privy.sends.length, 0);
      } finally { s.cleanup(); }
    }
  });

  it('approves USDC into the user’s canonical account and enforces the global vote budget', async () => {
    const s = service({ usdc: true, maxApprovalsPerHour: 1 });
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.setProposal(1n, [s.keys.user]);
      assert.equal((await s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' })).status, 'approved');
      s.setProposal(2n, [s.keys.user]);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '2' }), 429);
      assert.equal(s.privy.sends.length, 1);
    } finally { s.cleanup(); }
  });

  it('refuses a vault whose wallet became delegated after registration', async () => {
    const s = service();
    try {
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.user.solanaWallets[0].delegated = true;
      s.setProposal(1n, [s.keys.user]);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 403, /delegated/);
      assert.equal(s.privy.sends.length, 0);
    } finally { s.cleanup(); }
  });

  it('rejects malformed bodies, an unverifiable user, another account and an unapproved proposal without signing', async () => {
    const s = service();
    try {
      await rejectsWith(s.guardian.register(s.user.id, { multisig: 'x' }), 400);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: 1 }), 400);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '0' }), 400);
      await rejectsWith(s.guardian.register('did:privy:unknown', { multisig: s.keys.multisig }), 503, /Privy/);
      await s.guardian.register(s.user.id, { multisig: s.keys.multisig });
      s.setProposal(1n, []);
      await rejectsWith(s.guardian.approve(s.user.id, { multisig: s.keys.multisig, transactionIndex: '1' }), 403, /Approve the release with your wallet/);
      s.setProposal(1n, [s.keys.user]);
      await rejectsWith(s.guardian.approve('did:privy:bob', { multisig: s.keys.multisig, transactionIndex: '1' }), 403, /another account/);
      await rejectsWith(s.guardian.register('did:privy:bob', { multisig: s.keys.multisig }), 403, /not paired with a wallet linked/);
      assert.equal(s.privy.sends.length, 0);
      assert.ok(s.audits.length > 0);
      assert.ok(!JSON.stringify(s.audits).includes(s.authKey), 'audit events carry no key material');
    } finally { s.cleanup(); }
  });
});

describe('cluster check (production incident 2026-10-14)', () => {
  it('accepts the full genesis hash a real RPC returns and refuses the CAIP-2 prefix', async () => {
    const { readRegistrationSnapshot } = await import('./guardian');
    const rpc = (genesis: string) => ({ genesisHash: async () => genesis, accounts: async (a: string[]) => a.map(() => null), countSpendingLimits: async () => 0, latestBlockhash: async () => '11111111111111111111111111111111' });
    const multisig = 'EMBKd4yFBPGFYSn6aBBRQuy3uy9oZL9XWwFvvWV4rj9o';
    const ok = await readRegistrationSnapshot(rpc('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), 'mainnet-beta', multisig);
    assert.equal(ok.spendingLimitCount, 0);
    await assert.rejects(readRegistrationSnapshot(rpc('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'mainnet-beta', multisig), /different cluster/);
  });
});
