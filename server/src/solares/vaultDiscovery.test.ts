// On-chain discovery of unregistered paired vaults (account()) and the stored first-passkey window
// (layers/service.ts noteRegistration). Fakes: Privy, the clock and a Solana RPC whose getProgramAccounts
// applies the real dataSize and memcmp filters to the fake chain, so the filters themselves are under test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { SOLANA_GENESIS } from '../../../src/solares/wallet/solanaNetwork';
import { SQUADS_PROGRAM_ID, type RawSolanaAccount } from '../../../src/solares/paired/solanaDecode';
import { multisigAccount, newWallet, pairedKeys, recentBlockhash, type PairedFixtureKeys } from '../../../src/solares/paired/testFixtures';
import {
  DISCOVERY_LIMITS, DISCOVERY_TTL_MS, GUARDIAN_ENV, PAIRED_MEMBER_OFFSETS, PAIRED_MULTISIG_DATA_SIZE, SQUADS_MULTISIG_DISCRIMINATOR, createGuardianSigner, createPairedVaultGuardian,
  pairedMultisigDiscoveryFilters, readGuardianConfig, solanaJsonRpc, type GuardianPrivyClient, type SolanaRpc,
} from './guardian.js';
import { layerServerConfig } from './layers/config.js';
import { activationSessionHash, createVaultLayerService, type LayerRequestContext } from './layers/service.js';
import { createTestAuthenticator } from './layers/testAuthenticator.js';
import { ACTIVATION_WINDOW_MS } from './layers/types.js';
import type { LinkedSolanaWallet, PrivyUserFacts } from './vaultPolicy.js';
import { VAULT_STORE_FILE, VaultStoreError, createVaultStore, type PairedVaultRecord } from './vaultStore.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const ALICE = 'did:privy:alice';
const linked = (address: string, extra: Partial<LinkedSolanaWallet> = {}): LinkedSolanaWallet =>
  ({ address, embedded: true, delegated: false, imported: false, userCanSign: true, ...extra });
const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string } };
/** getProgramAccounts as an RPC node answers it: Squads-owned accounts matching every filter. */
function programAccounts(chain: Map<string, RawSolanaAccount | null>, filters: Filter[]) {
  return [...chain.values()].filter((account): account is RawSolanaAccount => !!account && account.owner === SQUADS_PROGRAM_ID && filters.every(filter => {
    if (filter.dataSize !== undefined) return account.data.length === filter.dataSize;
    const bytes = bs58.decode(filter.memcmp!.bytes);
    return bytes.every((byte, index) => account.data[filter.memcmp!.offset + index] === byte);
  }));
}
/** The members in Squads' stored order (sorted by key), as a real paired vault has them. */
const sortedMembers = (keys: PairedFixtureKeys) =>
  [{ key: keys.user, mask: 7 }, { key: keys.guardian, mask: 2 }].sort((a, b) => Buffer.compare(Buffer.from(bs58.decode(a.key)), Buffer.from(bs58.decode(b.key))));

function setup(options: { discovery?: boolean; deadlineMs?: number } = {}) {
  const keys = pairedKeys();
  const dir = mkdtempSync(join(tmpdir(), 'antara-discovery-'));
  const file = join(dir, VAULT_STORE_FILE);
  const chain = new Map<string, RawSolanaAccount | null>([[keys.multisig, multisigAccount(keys, { members: sortedMembers(keys) })]]);
  const calls = { programAccounts: 0, spendingLimits: 0 };
  const faults = { programAccounts: null as null | 'fail' | 'hang', genesis: SOLANA_GENESIS['mainnet-beta'] as string, spendingLimits: 0 };
  const rpc: SolanaRpc = {
    genesisHash: async () => faults.genesis,
    accounts: async list => list.map(address => chain.get(address) ?? null),
    countSpendingLimits: async () => { calls.spendingLimits += 1; return faults.spendingLimits; },
    latestBlockhash: async () => recentBlockhash(),
  };
  // The same shape solanaJsonRpc implements: both member orders, de-duplicated.
  if (options.discovery !== false) {
    rpc.pairedMultisigs = async (member, guardian) => {
      calls.programAccounts += 2;
      if (faults.programAccounts === 'fail') throw new Error('RPC getProgramAccounts failed');
      if (faults.programAccounts === 'hang') return new Promise<RawSolanaAccount[]>(() => {});
      const found = new Map<string, RawSolanaAccount>();
      for (const filters of pairedMultisigDiscoveryFilters(member, guardian)) for (const account of programAccounts(chain, filters)) found.set(account.address, account);
      return [...found.values()];
    };
  }
  const env = {
    [GUARDIAN_ENV.authorizationKey]: p256().privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    [GUARDIAN_ENV.walletId]: 'walletid0000000000000001', [GUARDIAN_ENV.address]: keys.guardian, [GUARDIAN_ENV.policyId]: 'policyid0000000000000001',
    [GUARDIAN_ENV.signerId]: 'quorumsigner000000000001', [GUARDIAN_ENV.ownerQuorumId]: 'quorumowner0000000000001',
  };
  const config = readGuardianConfig(env);
  const admin = p256().publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privy: GuardianPrivyClient = {
    async getWallet(id) {
      return { id, address: keys.guardian, chain_type: 'solana', owner_id: config.ownerQuorumId, policy_ids: [config.policyId], additional_signers: [{ signer_id: config.signerId, override_policy_ids: [config.policyId] }], exported_at: null, imported_at: null, archived_at: null };
    },
    async getKeyQuorum(id) {
      if (id === config.signerId) return { id, authorization_keys: [{ public_key: config.serverPublicKey }], authorization_threshold: 1, user_ids: null };
      return { id, authorization_keys: [{ public_key: config.serverPublicKey }, { public_key: admin }], authorization_threshold: 2, user_ids: null };
    },
    async signAndSendTransaction() { throw new Error('nothing is signed in these tests'); },
  };
  const users: Record<string, PrivyUserFacts> = {
    [ALICE]: { id: ALICE, solanaWallets: [linked(keys.user)] },
    'did:privy:bob': { id: 'did:privy:bob', solanaWallets: [linked(newWallet())] },
  };
  const loadUser = async (id: string) => { const user = users[id]; if (!user) throw new Error('unknown user'); return user; };
  let clock = NOW;
  const store = createVaultStore(file, { requireReleaseAuthorization: true });
  const guardian = createPairedVaultGuardian({
    guardian: createGuardianSigner({ config, client: privy, latestBlockhash: rpc.latestBlockhash }),
    rpc, cluster: 'mainnet-beta', store, now: () => clock, loadUser, audit: () => {}, discoveryDeadlineMs: options.deadlineMs,
  });
  /** A layer service on the same store file, started now; a new one is what a server restart starts with (nothing in memory). */
  const layerService = (startedAt = clock) => createVaultLayerService({
    store: createVaultStore(file, { requireReleaseAuthorization: true }), rpc, cluster: 'mainnet-beta', guardian: keys.guardian, now: () => clock, startedAt, loadUser,
    passkeyConfig: () => layerServerConfig({}), network: { production: false, trustProxy: 1 }, audit: () => {},
  });
  const record = (overrides: Partial<PairedVaultRecord> = {}): PairedVaultRecord =>
    ({ privyUserId: ALICE, user: keys.user, multisig: keys.multisig, guardian: keys.guardian, vault: keys.vault, createdAt: new Date(clock).toISOString(), ...overrides });
  return {
    keys, file, chain, calls, faults, users, store, guardian, layerService, record,
    now: () => clock, advance: (ms: number) => { clock += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('paired-vault discovery filters', () => {
  it('match the exact paired layout: 198 bytes, the Squads multisig discriminator, members at 132 and 165 in either order', () => {
    const keys = pairedKeys();
    const created = multisigAccount(keys);
    assert.equal(created.data.length, PAIRED_MULTISIG_DATA_SIZE);
    assert.equal(SQUADS_MULTISIG_DISCRIMINATOR, bs58.encode(created.data.subarray(0, 8)));
    assert.deepEqual([...PAIRED_MEMBER_OFFSETS], [132, 165]);
    assert.equal(bs58.encode(created.data.subarray(132, 164)), keys.user);
    assert.equal(bs58.encode(created.data.subarray(165, 197)), keys.guardian);
    const filters = pairedMultisigDiscoveryFilters(keys.user, keys.guardian);
    assert.deepEqual(filters.map(set => set.slice(2).map(item => (item as Filter).memcmp!.bytes)), [[keys.user, keys.guardian], [keys.guardian, keys.user]]);
    const chain = new Map<string, RawSolanaAccount | null>([['a', created], ['b', multisigAccount(keys, { address: 'b', members: [{ key: keys.guardian, mask: 2 }, { key: keys.user, mask: 7 }] })]]);
    assert.deepEqual(filters.map(set => programAccounts(chain, set as Filter[]).map(item => item.address)), [[keys.multisig], ['b']]);
    // Without a rent collector the account is 166 bytes: never an ANTARA-created paired vault, so not matched.
    chain.set('c', multisigAccount(keys, { address: 'c', rentCollector: null }));
    assert.equal(filters.flatMap(set => programAccounts(chain, set as Filter[])).some(item => item.address === 'c'), false);
    assert.throws(() => pairedMultisigDiscoveryFilters(keys.user, keys.user), /two different wallet addresses/);
    assert.throws(() => pairedMultisigDiscoveryFilters(keys.vault, keys.guardian), /two different wallet addresses/);
  });

  it('solanaJsonRpc searches both member orders with getProgramAccounts and refuses malformed answers', async () => {
    const keys = pairedKeys();
    const account = multisigAccount(keys);
    const bodies: Array<{ method: string; params: [string, { filters: Filter[]; encoding: string }] }> = [];
    const wire = { owner: account.owner, data: [Buffer.from(account.data).toString('base64'), 'base64'], lamports: 1, executable: false, rentEpoch: 0 };
    let answer: (index: number) => unknown = () => [{ pubkey: keys.multisig, account: wire }];
    const fetcher = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body); bodies.push(body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(bodies.length - 1) }));
    }) as unknown as typeof fetch;
    const rpc = solanaJsonRpc('https://rpc.example.test', { fetch: fetcher });
    // The same vault from both searches is reported once.
    assert.deepEqual(await rpc.pairedMultisigs!(keys.user, keys.guardian), [account]);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.method, 'getProgramAccounts'); assert.equal(body.params[0], SQUADS_PROGRAM_ID); assert.equal(body.params[1].encoding, 'base64');
    }
    assert.deepEqual(bodies.map(body => body.params[1].filters), pairedMultisigDiscoveryFilters(keys.user, keys.guardian));
    answer = () => [];
    assert.deepEqual(await rpc.pairedMultisigs!(keys.user, keys.guardian), []);
    answer = () => ({ not: 'a list' });
    await assert.rejects(rpc.pairedMultisigs!(keys.user, keys.guardian), /unexpected program account list/);
    answer = () => [{ pubkey: 'not an address', account: wire }];
    await assert.rejects(rpc.pairedMultisigs!(keys.user, keys.guardian), /unexpected program account/);
    answer = () => [{ pubkey: keys.multisig, account: { ...wire, data: ['AA==', 'base58'] } }];
    await assert.rejects(rpc.pairedMultisigs!(keys.user, keys.guardian), /unexpected account/);
  });
});

describe('account(): unregistered paired vaults found on Solana', () => {
  it('reports a created but unregistered vault (members in sorted order) so another app offers Finish activation, then not once registered', async () => {
    const s = setup();
    try {
      const before = await s.guardian.account(ALICE);
      assert.deepEqual(before.vaults, []);
      assert.deepEqual(before.unregistered, [{ multisig: s.keys.multisig, vault: s.keys.vault, user: s.keys.user, guardian: s.keys.guardian }]);
      // Another account's wallets never see it.
      assert.deepEqual((await s.guardian.account('did:privy:bob')).unregistered, []);
      assert.equal((await s.guardian.register(ALICE, { multisig: s.keys.multisig })).status, 'registered');
      const calls = s.calls.programAccounts;
      const after = await s.guardian.account(ALICE);
      assert.deepEqual(after.vaults.map(item => item.multisig), [s.keys.multisig]);
      assert.deepEqual(after.unregistered, []);
      assert.equal(s.calls.programAccounts, calls, 'a wallet with a registered vault costs no discovery read');
    } finally { s.cleanup(); }
  });

  it('reuses one answer for 30 seconds, then reads the chain again', async () => {
    const s = setup();
    try {
      await Promise.all([s.guardian.account(ALICE), s.guardian.account(ALICE)]);
      assert.equal(s.calls.programAccounts, 2, 'concurrent reads share one search (two member orders)');
      s.advance(DISCOVERY_TTL_MS - 1);
      await s.guardian.account(ALICE);
      assert.equal(s.calls.programAccounts, 2);
      s.advance(1);
      await s.guardian.account(ALICE);
      assert.equal(s.calls.programAccounts, 4);
    } finally { s.cleanup(); }
  });

  it('look-alike accounts that match the search but fail the rules cannot crowd out the real vault', async () => {
    const s = setup();
    try {
      // Anyone can create Squads multisigs with the user and guardian at the member offsets; these fail the rules.
      const lookAlikes = Array.from({ length: 2 * DISCOVERY_LIMITS.vaults + 3 }, (_, index) => {
        const other: PairedFixtureKeys = { ...pairedKeys(), user: s.keys.user, guardian: s.keys.guardian };
        return multisigAccount(other, { members: sortedMembers(s.keys), ...(index % 2 ? { threshold: 1 } : { timeLock: 60 }) });
      });
      // Placed ahead of the real vault, as a node may return them in any order.
      const real = s.chain.get(s.keys.multisig)!;
      s.chain.clear();
      for (const account of lookAlikes) s.chain.set(account.address, account);
      s.chain.set(s.keys.multisig, real);
      assert.deepEqual((await s.guardian.account(ALICE)).unregistered, [{ multisig: s.keys.multisig, vault: s.keys.vault, user: s.keys.user, guardian: s.keys.guardian }]);
      assert.equal(s.calls.spendingLimits, 1, 'spending limits are read only for exact shapes');
    } finally { s.cleanup(); }
  });

  it('reports only exact paired vaults of this guardian and wallet', async () => {
    for (const [label, options] of [
      ['guardian may initiate', { members: [{ key: 'user', mask: 7 }, { key: 'guardian', mask: 7 }] }],
      ['threshold 1', { threshold: 1 }],
      ['configuration authority', { configAuthority: newWallet() }],
      ['time lock', { timeLock: 60 }],
      ['another guardian', { members: [{ key: 'user', mask: 7 }, { key: newWallet(), mask: 2 }] }],
      ['rent to someone else', { rentCollector: newWallet() }],
    ] as const) {
      const s = setup();
      try {
        const members = 'members' in options ? options.members.map(member => ({ key: member.key === 'user' ? s.keys.user : member.key === 'guardian' ? s.keys.guardian : member.key, mask: member.mask })) : undefined;
        s.chain.set(s.keys.multisig, multisigAccount(s.keys, { ...options, ...(members ? { members } : {}) }));
        assert.deepEqual((await s.guardian.account(ALICE)).unregistered, [], label);
      } finally { s.cleanup(); }
    }
    const s = setup();
    try {
      s.faults.spendingLimits = 1;
      assert.deepEqual((await s.guardian.account(ALICE)).unregistered, [], 'a vault with a spending limit is never offered');
    } finally { s.cleanup(); }
  });

  it('does not offer a vault registered to any account, nor search for a wallet that cannot pair', async () => {
    const s = setup();
    try {
      s.store.registerVault(s.record({ privyUserId: 'did:privy:bob' }));
      assert.deepEqual((await s.guardian.account(ALICE)).unregistered, []);
      const t = setup();
      try {
        t.users[ALICE].solanaWallets[0] = linked(t.keys.user, { delegated: true });
        assert.deepEqual((await t.guardian.account(ALICE)).unregistered, []);
        assert.equal(t.calls.programAccounts, 0);
      } finally { t.cleanup(); }
    } finally { s.cleanup(); }
  });

  it('answers the account without `unregistered` when the search cannot run, and searches again next time', async () => {
    const s = setup();
    const errors = console.error;
    const logged: string[] = [];
    console.error = (line: string) => { logged.push(line); };
    try {
      s.faults.programAccounts = 'fail';
      const failed = await s.guardian.account(ALICE);
      assert.equal('unregistered' in failed, false);
      assert.deepEqual(failed.wallets.map(item => item.address), [s.keys.user]);
      s.faults.programAccounts = null;
      assert.equal((await s.guardian.account(ALICE)).unregistered?.length, 1, 'a failure is not cached');
      // An RPC on another cluster is never searched.
      const t = setup();
      try {
        t.faults.genesis = SOLANA_GENESIS.devnet;
        assert.equal('unregistered' in await t.guardian.account(ALICE), false);
        assert.equal(t.calls.programAccounts, 0);
      } finally { t.cleanup(); }
      assert.ok(logged.every(line => !line.includes(s.keys.user) && !line.includes(s.keys.multisig)), 'the operator log carries no address');
    } finally { console.error = errors; s.cleanup(); }
  });

  it('stops waiting at the deadline, and an RPC without discovery reports nothing (older wire shape)', async () => {
    const s = setup({ deadlineMs: 20 });
    const errors = console.error;
    console.error = () => {};
    try {
      s.faults.programAccounts = 'hang';
      const started = Date.now();
      assert.equal('unregistered' in await s.guardian.account(ALICE), false);
      assert.ok(Date.now() - started < 5_000);
    } finally { console.error = errors; s.cleanup(); }
    const t = setup({ discovery: false });
    try {
      assert.deepEqual(await t.guardian.account(ALICE), { mfaEnrolled: true, vaults: [], wallets: [{ address: t.keys.user, embedded: true, pairProblem: null }] });
    } finally { t.cleanup(); }
  });
});

describe('first-passkey window stored with the registration', () => {
  const sessionA: LayerRequestContext = { ip: '203.0.113.7', sessionId: 'session-a' };
  const sessionB: LayerRequestContext = { ip: '203.0.113.7', sessionId: 'session-b' };
  const authenticator = createTestAuthenticator({ rpId: 'localhost', origin: 'http://localhost:1420' });
  const passkeyAdd = (multisig: string) => ({ multisig, op: { type: 'passkey.add', label: 'Laptop' } });
  async function addPasskey(layers: ReturnType<ReturnType<typeof setup>['layerService']>, multisig: string, context: LayerRequestContext) {
    const begin = await layers.beginChange(ALICE, passkeyAdd(multisig), 'enroll', context);
    const { response } = authenticator.register({ challenge: begin.webauthn.create!.challenge, counter: 1 });
    return { begin, finish: await layers.finishChange(ALICE, { multisig, challengeId: begin.challengeId, registration: response }, 'enroll', context) };
  }

  it('survives a restart: the registering session still adds its first passkey at once, another session still cannot', async () => {
    const s = setup();
    try {
      s.store.registerVault(s.record());
      await s.layerService().noteRegistration(ALICE, s.keys.multisig, sessionA, 'registered');
      const window = s.store.getVault(s.keys.multisig)?.activation;
      assert.deepEqual(window, { privyUserId: ALICE, sessionHash: activationSessionHash('session-a'), openedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + ACTIVATION_WINDOW_MS).toISOString() });
      assert.equal(readFileSync(s.file, 'utf8').includes('session-a'), false, 'the session id itself is never stored');
      // A deploy in between: a fresh service with nothing in memory.
      s.advance(10 * 60 * 1000);
      const restarted = s.layerService();
      await assert.rejects(restarted.beginChange(ALICE, passkeyAdd(s.keys.multisig), 'enroll', sessionB), /app that activated it/);
      const { begin, finish } = await addPasskey(restarted, s.keys.multisig, sessionA);
      assert.equal(begin.class, 'tighten'); assert.equal(begin.effectiveAt, null);
      assert.deepEqual(finish, { status: 'applied', configVersion: 1 });
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined, 'the window is used once');
      assert.equal(s.store.layerConfig(s.keys.multisig)?.biometrics?.credentials.length, 1);
      // Registering again opens nothing for a vault that has its passkey.
      await restarted.noteRegistration(ALICE, s.keys.multisig, sessionA, 'already-registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined);
    } finally { s.cleanup(); }
  });

  it('closes at registration + 15 minutes, never later, and is never re-bound by a later registration', async () => {
    const s = setup();
    try {
      s.store.registerVault(s.record());
      await s.layerService().noteRegistration(ALICE, s.keys.multisig, sessionA, 'registered');
      s.advance(5 * 60 * 1000);
      await s.layerService().noteRegistration(ALICE, s.keys.multisig, sessionB, 'already-registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation?.sessionHash, activationSessionHash('session-a'), 'not moved to the session that asked next');
      s.advance(10 * 60 * 1000);
      const late = await s.layerService().beginChange(ALICE, passkeyAdd(s.keys.multisig), 'enroll', sessionA);
      assert.equal(late.class, 'recovery', 'after the window the first passkey is the 7-day recovery change');
    } finally { s.cleanup(); }
  });

  it('opens on already-registered only for a registration from before this server started, inside its window, with no passkey and no window yet', async () => {
    const s = setup();
    try {
      // Registered before this server process (its window note lost in a restart or deploy), or with no session recorded.
      s.store.registerVault(s.record());
      await s.layerService().noteRegistration(ALICE, s.keys.multisig, { ip: null, sessionId: null }, 'registered');
      s.advance(6 * 60 * 1000);
      const restarted = s.layerService();
      await restarted.noteRegistration('did:privy:bob', s.keys.multisig, sessionB, 'already-registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined, 'nothing without a session, nothing for another account');
      await restarted.noteRegistration(ALICE, s.keys.multisig, sessionB, 'already-registered');
      // Same deadline as at registration: the window is not lengthened by reopening it.
      assert.equal(s.store.getVault(s.keys.multisig)?.activation?.expiresAt, new Date(NOW + ACTIVATION_WINDOW_MS).toISOString());
      const { begin, finish } = await addPasskey(s.layerService(), s.keys.multisig, sessionB);
      assert.equal(begin.class, 'tighten'); assert.equal(finish.status, 'applied');
    } finally { s.cleanup(); }
  });

  it('a registration made by this server process is opened only by the session that registered it', async () => {
    const s = setup();
    try {
      const live = s.layerService();
      s.advance(1_000);
      s.store.registerVault(s.record());
      // Another session of the same account answers first (already-registered): it never claims the window.
      await live.noteRegistration(ALICE, s.keys.multisig, sessionB, 'already-registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined);
      await live.noteRegistration(ALICE, s.keys.multisig, sessionA, 'registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation?.sessionHash, activationSessionHash('session-a'));
      await assert.rejects(live.beginChange(ALICE, passkeyAdd(s.keys.multisig), 'enroll', sessionB), /app that activated it/);
      const { begin } = await addPasskey(live, s.keys.multisig, sessionA);
      assert.equal(begin.class, 'tighten');
    } finally { s.cleanup(); }
    // A registration in the same millisecond the server started is this process's too.
    const t = setup();
    try {
      const live = t.layerService();
      t.store.registerVault(t.record());
      await live.noteRegistration(ALICE, t.keys.multisig, sessionB, 'already-registered');
      assert.equal(t.store.getVault(t.keys.multisig)?.activation, undefined);
    } finally { t.cleanup(); }
  });

  it('does not open after the window, or while a recovery passkey is pending', async () => {
    const s = setup();
    try {
      s.store.registerVault(s.record());
      s.advance(ACTIVATION_WINDOW_MS);
      await s.layerService().noteRegistration(ALICE, s.keys.multisig, sessionA, 'already-registered');
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined);
    } finally { s.cleanup(); }
    const t = setup();
    try {
      t.store.registerVault(t.record());
      // No window: the first passkey is queued as a recovery change.
      const { begin, finish } = await addPasskey(t.layerService(), t.keys.multisig, sessionA);
      assert.equal(begin.class, 'recovery'); assert.equal(finish.status, 'pending');
      // Even after a restart (the registration predates the server), a pending passkey is not bypassed by a new window.
      await t.layerService(t.now() + 1).noteRegistration(ALICE, t.keys.multisig, sessionA, 'already-registered');
      assert.equal(t.store.getVault(t.keys.multisig)?.activation, undefined, 'a pending passkey is not bypassed by a new window');
    } finally { t.cleanup(); }
  });
});

describe('vault store: the stored window', () => {
  it('is set once, only for the registered account, validated on read, and an older record without it still reads', () => {
    const s = setup();
    try {
      s.store.registerVault(s.record());
      const window = { privyUserId: ALICE, sessionHash: activationSessionHash('session-a'), openedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + ACTIVATION_WINDOW_MS).toISOString() };
      assert.throws(() => s.store.openActivation(s.keys.multisig, { ...window, privyUserId: 'did:privy:bob' }), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict');
      assert.throws(() => s.store.openActivation(s.keys.multisig, { ...window, sessionHash: 'session-a' }), /invalid/);
      assert.equal(s.store.openActivation(s.keys.multisig, window), true);
      assert.equal(s.store.openActivation(s.keys.multisig, { ...window, sessionHash: activationSessionHash('session-b') }), false);
      assert.equal(s.store.getVault(s.keys.multisig)?.activation?.sessionHash, window.sessionHash);
      // Registration stays idempotent with a window recorded.
      assert.equal(s.store.registerVault(s.record({ createdAt: new Date(NOW + 1).toISOString() })).created, false);
      s.store.closeActivation(s.keys.multisig);
      assert.equal(s.store.getVault(s.keys.multisig)?.activation, undefined);
      assert.equal(s.store.vaultsForUser(ALICE).length, 1);
      // A damaged window fails closed like any other damaged registration.
      const document = JSON.parse(readFileSync(s.file, 'utf8'));
      document.vaults[s.keys.multisig].activation = { ...window, sessionHash: 'x' };
      writeFileSync(s.file, JSON.stringify(document));
      assert.throws(() => s.store.getVault(s.keys.multisig), /invalid registration/);
      document.vaults[s.keys.multisig].activation = { ...window, privyUserId: 'did:privy:bob' };
      writeFileSync(s.file, JSON.stringify(document));
      assert.throws(() => s.store.getVault(s.keys.multisig), /invalid registration/);
      delete document.vaults[s.keys.multisig].activation;
      writeFileSync(s.file, JSON.stringify(document));
      assert.equal(s.store.getVault(s.keys.multisig)?.multisig, s.keys.multisig);
    } finally { s.cleanup(); }
  });
});
