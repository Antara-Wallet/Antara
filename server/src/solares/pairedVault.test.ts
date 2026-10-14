import { SOLANA_GENESIS } from '../../../src/solares/wallet/solanaNetwork';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import Safe from '@safe-global/protocol-kit';
import { getCompatibilityFallbackHandlerDeployment, getProxyFactoryDeployment, getSafeL2SingletonDeployment, getSafeSingletonDeployment } from '@safe-global/safe-deployments';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from 'express';
import {
  GUARDIAN_NOT_PROVISIONED, GuardianNotProvisionedError, PAIRED_VAULTS_ENABLED_ENV, PAIRED_VAULT_NETWORKS, defaultSolanaGuardian, isPairedVaultDeployed, openVaultStoreAtBoot,
  pairedVaultRouter, pairedVaultsEnabled, predictPairedVault,
  type PairedVaultConfig,
} from './pairedVault.js';
import { GUARDIAN_ENV, GuardianError, createGuardianSigner, createPairedVaultGuardian, readGuardianConfig, type GuardianPrivyClient, type GuardianSendInput, type PairedVaultGuardian, type SolanaRpc } from './guardian.js';
import type { LinkedSolanaWallet, PrivyUserFacts } from './vaultPolicy.js';
import { VAULT_STORE_FILE, createVaultStore } from './vaultStore.js';
import type { SolaresUser } from './wallet.js';
import { layerServerConfig } from './layers/config.js';
import { createVaultLayerService, type LayerAuditEvent } from './layers/service.js';
import { createTestAuthenticator, createTestDevice, type TestPasskey } from './layers/testAuthenticator.js';
import { bluetoothMatchId } from './layers/digest.js';
import { TOTP_KEY_ENV, base32Decode, openTotpSecret, totpCode, totpKeyFromEnv } from './layers/totp.js';
import { resolveCosignerAddress } from '../providers/cosigner.js';
import { byKey, type EvmNetworkKey } from '../../../src/solares/networks';
import { pairedVaultAddresses, type RawSolanaAccount } from '../../../src/solares/paired/solanaDecode';
import { multisigAccount, newWallet, pairedKeys, proposalAccount, recentBlockhash, vaultTransactionAccount, type MultisigFixtureOptions, type PairedFixtureKeys } from '../../../src/solares/paired/testFixtures';
import { encodeAbiParameters, isAddress, type Address } from 'viem';

const owner: Address = '0x1111111111111111111111111111111111111111';
const cosigner: Address = '0x2222222222222222222222222222222222222222';
const address: Address = '0x3333333333333333333333333333333333333333';
function setup(options: { configured: boolean; deployed: boolean; fail: boolean; stall?: boolean } = { configured: true, deployed: true, fail: false }) {
  const predictions: { chain: EvmNetworkKey; config: PairedVaultConfig }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const auth = { calls: 0 };
  const app = express();
  app.use('/vault', pairedVaultRouter({
    authenticate(req, _res, next) { auth.calls += 1; req.solaresUser = { id: 'test', wallets: [{ address: owner, chainType: 'ethereum', embedded: true }, { address: 'SolanaOwner', chainType: 'solana', embedded: true }] }; next(); },
    configured: () => options.configured,
    cosigner: () => cosigner,
    async predict(chain, config, signal) { predictions.push({ chain, config }); signals.push(signal); if (options.fail) throw new Error('private provider details'); return address; },
    deployed(_chain, _address, signal) { signals.push(signal); return options.stall ? new Promise<boolean>(() => {}) : Promise.resolve(options.deployed); },
    timeoutMs: 50,
  }));
  return { app, predictions, signals, auth };
}
describe('ARK paired-vault discovery', () => {
  it('derives the original two-signature vault from the authenticated wallet, never client-supplied owners', async () => {
    const { app, predictions } = setup();
    const result = await request(app).get('/vault').query({ owner, chain: 'base', cosigner: address, threshold: 1 }).expect(200);
    assert.deepEqual(predictions, [{ chain: 'base', config: { owners: [owner, cosigner], threshold: 2 } }]);
    assert.equal(result.body.status, 'deployed'); assert.equal(result.body.address, address);
    assert.equal(result.body.creationEnabled, false); assert.equal(result.body.transfersEnabled, false);
    assert.equal(result.headers['cache-control'], 'no-store');
  });
  it('rejects another wallet before discovery', async () => {
    const { app, predictions } = setup();
    await request(app).get('/vault').query({ owner: address, chain: 'ethereum' }).expect(403);
    assert.equal(predictions.length, 0);
  });
  it('does not return an undeployed address as a deposit destination', async () => {
    const { app } = setup({ configured: true, deployed: false, fail: false });
    const result = await request(app).get('/vault').query({ owner, chain: 'bsc' }).expect(200);
    assert.equal(result.body.status, 'not-created'); assert.equal(result.body.address, undefined);
    assert.equal(result.body.chainId, 56);
  });
  it('discovers on every Safe network in the registry, keyed by the requested network', async () => {
    assert.deepEqual(PAIRED_VAULT_NETWORKS, ['ethereum', 'bsc', 'robinhood', 'base']);
    const { app, predictions } = setup();
    for (const [chain, chainId] of [['ethereum', 1], ['bsc', 56], ['robinhood', 4663], ['base', 8453]] as const) {
      const result = await request(app).get('/vault').query({ owner, chain }).expect(200);
      assert.equal(result.body.chain, chain); assert.equal(result.body.chainId, chainId); assert.equal(result.body.status, 'deployed');
    }
    assert.deepEqual(predictions.map(item => item.chain), ['ethereum', 'bsc', 'robinhood', 'base']);
  });
  it('reports missing service configuration without inventing a vault', async () => {
    const { app, predictions } = setup({ configured: false, deployed: false, fail: false });
    const result = await request(app).get('/vault').query({ owner, chain: 'ethereum' }).expect(200);
    assert.equal(result.body.status, 'unavailable'); assert.equal(predictions.length, 0);
  });
  it('does not substitute Squads or a different chain for an unsupported paired vault', async () => {
    const { app, predictions } = setup();
    const solana = await request(app).get('/vault').query({ owner: 'SolanaOwner', chain: 'solana' }).expect(200);
    assert.equal(solana.body.status, 'unsupported'); assert.match(solana.body.message, /EVM Safe vaults only/);
    assert.equal(solana.body.address, undefined); assert.equal(solana.body.chainId, undefined);
    // Saved Arbitrum or Polygon selections render honestly as no longer supported.
    for (const [chain, name] of [['arbitrum', 'Arbitrum'], ['polygon', 'Polygon']]) {
      const result = await request(app).get('/vault').query({ owner, chain }).expect(200);
      assert.equal(result.body.status, 'unsupported'); assert.equal(result.body.message, `${name} is no longer supported by ANTARA.`);
    }
    for (const chain of ['optimism', 'bnb', 'robinhood-testnet', '4663', '']) await request(app).get('/vault').query({ owner, chain }).expect(400);
    assert.equal(predictions.length, 0);
  });
  it('reports failed reads as errors, never as empty vaults', async () => {
    const { app } = setup({ configured: true, deployed: false, fail: true });
    const result = await request(app).get('/vault').query({ owner, chain: 'base' }).expect(503);
    assert.equal(result.body.status, undefined); assert.doesNotMatch(result.body.error, /private provider/);
  });
  it('reports a stalled RPC read as an error within the discovery deadline and cancels the outstanding reads', async () => {
    const { app, signals } = setup({ configured: true, deployed: true, fail: false, stall: true });
    const result = await request(app).get('/vault').query({ owner, chain: 'robinhood' }).expect(503);
    assert.equal(result.body.status, undefined); assert.equal(result.body.address, undefined);
    // One deadline signal is shared by every read of the discovery and is aborted after the 503.
    assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]);
    assert.equal(signals[0]?.aborted, true);
  });
  it('leaves the deadline signal untouched when discovery finishes in time', async () => {
    const { app, signals } = setup();
    await request(app).get('/vault').query({ owner, chain: 'bsc' }).expect(200);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(signals.length, 2); assert.equal(signals[0]?.aborted, false);
  });
  it('exposes no creation, policy change, or signing operation', async () => {
    const { app } = setup();
    await request(app).post('/vault').send({ owner, chain: 'base' }).expect(404);
  });
  it('rate limits each account before fanning out to more RPC reads', async () => {
    const { app, predictions } = setup();
    const server = app.listen(0);
    try {
      for (let i = 0; i < 60; i++) await request(server).get('/vault').query({ owner, chain: 'base' }).expect(200);
      const limited = await request(server).get('/vault').query({ owner, chain: 'base' }).expect(429);
      assert.equal(limited.body.code, 'RATE_LIMITED'); assert.equal(limited.headers['retry-after'], '60');
      assert.equal(predictions.length, 60);
    } finally { server.close(); }
  });
  it('stops authentication calls once an IP exceeds the coarse pre-auth limit', async () => {
    const { app, auth } = setup();
    const server = app.listen(0);
    try {
      for (let i = 0; i < 120; i++) await request(server).get('/vault').query({ owner, chain: 'base' });
      assert.equal(auth.calls, 120);
      const limited = await request(server).get('/vault').query({ owner, chain: 'base' }).expect(429);
      assert.equal(limited.body.code, 'RATE_LIMITED'); assert.equal(auth.calls, 120);
    } finally { server.close(); }
  });
});
describe('paired-vault RPC reads', () => {
  // Canonical Safe 1.4.1 deployments, verified on Ethereum, BNB Smart Chain, Robinhood Chain and Base.
  const CANONICAL = {
    safe: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
    safeL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
    factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  } as const;
  // Stand-in for SafeProxyFactory.proxyCreationCode(); every prediction under test hashes the same bytes.
  const PROXY_CREATION_CODE = '0x608060405234801561001057600080fd5b50';
  const pairing: PairedVaultConfig = { owners: [owner, cosigner], threshold: 2 };
  let endpoint = 0;
  type Call = { url: string; method: string; params: unknown[] };
  // Each test gets fresh endpoints, so neither prediction cache carries results between tests.
  function mockRpc(t: TestContext, served: Partial<Record<EvmNetworkKey, number>>, code: (address: string) => string = () => '0x6080') {
    const chainIds = new Map<string, number>();
    endpoint += 1;
    for (const [chain, chainId] of Object.entries(served) as [EvmNetworkKey, number][]) {
      const name = byKey(chain).rpc.serverEnv;
      const url = `https://vault.test/${endpoint}/${chain}`;
      const previous = process.env[name];
      process.env[name] = url; chainIds.set(url, chainId);
      t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    }
    const calls: Call[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const chainId = chainIds.get(url);
      assert.ok(chainId !== undefined, 'tests must never contact a real RPC');
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
      const params = body.params ?? [];
      calls.push({ url, method: body.method, params });
      let result: unknown;
      if (body.method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
      else if (body.method === 'eth_getCode') result = code(String(params[0]));
      else if (body.method === 'eth_accounts') result = []; // protocol-kit only
      else if (body.method === 'eth_call') {
        const call = params[0] as { to: string; data: string };
        assert.equal(call.to.toLowerCase(), CANONICAL.factory.toLowerCase()); assert.equal(call.data, '0x53e5d935'); // proxyCreationCode()
        result = encodeAbiParameters([{ type: 'bytes' }], [PROXY_CREATION_CODE]);
      } else assert.fail(`Unexpected ${body.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  }
  const methods = (calls: Call[]) => calls.map(call => call.method);
  it('reads deployment only after the RPC proves it serves the requested chain', async t => {
    const calls = mockRpc(t, { robinhood: 4663 });
    assert.equal(await isPairedVaultDeployed('robinhood', address), true);
    assert.deepEqual(methods(calls), ['eth_chainId', 'eth_getCode']);
  });
  it('treats an empty account as not deployed', async t => {
    mockRpc(t, { robinhood: 4663 }, () => '0x');
    assert.equal(await isPairedVaultDeployed('robinhood', address), false);
  });
  it('fails closed when the configured RPC serves another chain', async t => {
    // A Base endpoint configured as ROBINHOOD_RPC_URL must not yield a Base address or deployment state.
    const calls = mockRpc(t, { robinhood: 8453 });
    await assert.rejects(isPairedVaultDeployed('robinhood', address), /chain mismatch/);
    await assert.rejects(predictPairedVault('robinhood', pairing), /chain mismatch/);
    assert.deepEqual(methods(calls), ['eth_chainId', 'eth_chainId']);
  });
  it('pins the canonical Safe 1.4.1 deployments every paired-vault network relies on, including Robinhood Chain', () => {
    // A safe-deployments release without chain 4663 (such as 1.37.56) must fail this test, not production discovery.
    assert.deepEqual(PAIRED_VAULT_NETWORKS.map(chain => byKey(chain).evmChainId), [1, 56, 4663, 8453]);
    for (const network of ['1', '56', '4663', '8453']) {
      const filter = { network, version: '1.4.1', released: true };
      assert.equal(getSafeSingletonDeployment(filter)?.networkAddresses[network], CANONICAL.safe, network);
      assert.equal(getSafeL2SingletonDeployment(filter)?.networkAddresses[network], CANONICAL.safeL2, network);
      assert.equal(getProxyFactoryDeployment(filter)?.networkAddresses[network], CANONICAL.factory, network);
      assert.equal(getCompatibilityFallbackHandlerDeployment(filter)?.networkAddresses[network], CANONICAL.fallbackHandler, network);
    }
  });
  it('predicts a Robinhood Chain vault offline from the canonical deployments and reuses only verified reads', async t => {
    const calls = mockRpc(t, { robinhood: 4663 });
    const predicted = await predictPairedVault('robinhood', pairing);
    assert.ok(isAddress(predicted, { strict: true }));
    assert.equal(methods(calls)[0], 'eth_chainId');
    const code = calls.filter(call => call.method === 'eth_getCode').map(call => String(call.params[0]).toLowerCase()).sort();
    assert.deepEqual(code, [CANONICAL.safeL2, CANONICAL.factory, CANONICAL.fallbackHandler].map(item => item.toLowerCase()).sort());
    assert.equal(methods(calls).filter(method => method === 'eth_call').length, 1);
    // The verified deployment is reused; the RPC must still prove its chain each time.
    calls.length = 0;
    assert.equal(await predictPairedVault('robinhood', pairing), predicted);
    assert.deepEqual(methods(calls), ['eth_chainId']);
  });
  it('predicts exactly the address protocol-kit predicts, distinct on every Safe network', async t => {
    mockRpc(t, { ethereum: 1, bsc: 56, robinhood: 4663, base: 8453 });
    const predicted = new Set<string>();
    for (const chain of PAIRED_VAULT_NETWORKS) {
      for (const config of [pairing, { owners: [cosigner, owner], threshold: 2 }, { owners: [owner, cosigner], threshold: 1 }]) {
        const kit = await Safe.init({ provider: String(process.env[byKey(chain).rpc.serverEnv]), predictedSafe: { safeAccountConfig: { owners: config.owners, threshold: config.threshold } } });
        const expected = await kit.getAddress();
        assert.equal(await predictPairedVault(chain, config), expected, `${chain} ${config.owners.join(',')} ${config.threshold}`);
        predicted.add(expected);
      }
    }
    // The salt is chain-specific, so one network's vault is never another network's address.
    assert.equal(predicted.size, PAIRED_VAULT_NETWORKS.length * 3);
  });
  it('fails closed without canonical Safe contracts and retries the reads on the next discovery', async t => {
    let factoryCode = '0x';
    const calls = mockRpc(t, { bsc: 56 }, target => target.toLowerCase() === CANONICAL.factory.toLowerCase() ? factoryCode : '0x6080');
    await assert.rejects(predictPairedVault('bsc', pairing), /Safe deployment unavailable/);
    assert.ok(!methods(calls).includes('eth_call'), 'no address is derived from an undeployed factory');
    factoryCode = '0x6080';
    assert.ok(isAddress(await predictPairedVault('bsc', pairing), { strict: true }));
  });
  it('cancels an outstanding read when the discovery deadline aborts it', async t => {
    endpoint += 1;
    const previous = process.env.ROBINHOOD_RPC_URL;
    process.env.ROBINHOOD_RPC_URL = `https://vault.test/${endpoint}/robinhood`;
    t.after(() => { if (previous === undefined) delete process.env.ROBINHOOD_RPC_URL; else process.env.ROBINHOOD_RPC_URL = previous; });
    const reads = { started: 0, aborted: 0 };
    let started!: () => void;
    const firstRead = new Promise<void>(resolve => { started = resolve; });
    t.mock.method(globalThis, 'fetch', (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      reads.started += 1; started();
      init?.signal?.addEventListener('abort', () => { reads.aborted += 1; reject(init.signal?.reason); });
    }));
    const deadline = new AbortController();
    const pending = isPairedVaultDeployed('robinhood', address, deadline.signal);
    await firstRead;
    deadline.abort();
    await assert.rejects(pending);
    assert.deepEqual(reads, { started: 1, aborted: 1 });
    // Nothing new starts once the deadline has passed.
    await assert.rejects(predictPairedVault('robinhood', pairing, deadline.signal));
    assert.deepEqual(reads, { started: 1, aborted: 1 });
  });
});
describe('public co-signer identity', () => {
  const checksummed: Address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const noKey = () => null;
  const neverDerive = () => { throw new Error('The signing key must not be consulted for an invalid COSIGNER_ADDRESS.'); };
  it('uses COSIGNER_ADDRESS on a server that holds no signing key', () => {
    assert.equal(resolveCosignerAddress(checksummed, noKey), checksummed);
    assert.equal(resolveCosignerAddress(` ${checksummed} `, noKey), checksummed);
  });
  it('accepts COSIGNER_ADDRESS only when it is the address of the configured key', () => {
    const warnings: string[] = [];
    const warn = (problem: string) => { warnings.push(problem); };
    assert.equal(resolveCosignerAddress(checksummed, () => checksummed, warn), checksummed);
    assert.equal(resolveCosignerAddress(checksummed, () => checksummed.toLowerCase() as Address, warn), checksummed);
    assert.deepEqual(warnings, []);
    // A mismatch would predict a vault the server cannot co-sign, so discovery fails closed.
    assert.equal(resolveCosignerAddress(checksummed, () => cosigner, warn), null);
    assert.deepEqual(warnings, ['COSIGNER_ADDRESS does not match COSIGNER_PRIVATE_KEY']);
  });
  it('rejects unchecksummed or malformed addresses instead of falling back to the key', () => {
    for (const value of [checksummed.toLowerCase(), '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x1234', 'not-an-address']) {
      const warnings: string[] = [];
      assert.equal(resolveCosignerAddress(value, neverDerive, problem => { warnings.push(problem); }), null, value);
      assert.deepEqual(warnings, ['COSIGNER_ADDRESS is not an EIP-55 checksummed address'], value);
    }
  });
  it('fails closed when the configured key cannot be loaded', () => {
    const broken = () => { throw new Error('invalid private key'); };
    assert.equal(resolveCosignerAddress(checksummed, broken), null);
    assert.equal(resolveCosignerAddress('', broken), null);
  });
  it('derives from the key only when no public address is configured', () => {
    assert.equal(resolveCosignerAddress('', () => cosigner), cosigner);
    assert.equal(resolveCosignerAddress('', () => null), null);
  });
});

describe('paired Solana vault routes', () => {
  const NOW = Date.parse('2026-10-12T12:00:00.000Z');
  const signature = (n: number) => `${'5'.repeat(87)}${'123456789'[n % 9]}`;
  const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const linked = (address: string): LinkedSolanaWallet => ({ address, embedded: true, delegated: false, imported: false, userCanSign: true });
  // Requests authenticate as `Bearer <privy user id>`; anything else is refused like requirePrivyUser does.
  // The session id stands in for verifyAccessToken().session_id, which requirePrivyUser records for every verified
  // token (wallet.ts; wallet.test.ts covers it). `session-a` unless X-Test-Session names another; `X-Test-Session: none`
  // records none, as requirePrivyUser does for a missing or malformed session id.
  const authenticate: RequestHandler = (req, res, next) => {
    const match = /^Bearer (did:privy:[a-z]+)$/.exec(req.headers.authorization || '');
    if (!match) { res.status(401).json({ error: 'A valid Privy session is required.' }); return; }
    const session = req.headers['x-test-session'] ?? 'session-a';
    req.solaresUser = { id: match[1], wallets: [], ...(typeof session === 'string' && session !== 'none' ? { sessionId: session } : {}) } as SolaresUser; next();
  };
  const evmDependencies = {
    authenticate, configured: () => false, cosigner: (): Address => cosigner,
    predict: async (): Promise<Address> => { throw new Error('EVM discovery is not under test'); },
    deployed: async () => false,
  };
  /** The real guardian service and policy, with Privy, the Solana RPC and the clock faked and storage in a temp dir. */
  function solanaRoutes() {
    const keys = pairedKeys();
    const carol: PairedFixtureKeys = { ...pairedKeys(), guardian: keys.guardian };
    const dir = mkdtempSync(join(tmpdir(), 'antara-paired-routes-'));
    const chain = new Map<string, RawSolanaAccount | null>([[keys.multisig, multisigAccount(keys, { transactionIndex: 3n })], [carol.multisig, multisigAccount(carol)]]);
    const reads = { accounts: 0 };
    const rpc: SolanaRpc = {
      genesisHash: async () => SOLANA_GENESIS['mainnet-beta'],
      accounts: async list => { reads.accounts += 1; return list.map(address => chain.get(address) ?? null); },
      countSpendingLimits: async () => 0,
      latestBlockhash: async () => recentBlockhash(),
      // A well-funded vault deposit address and the live rent-exempt minimum (vaultPolicy.ts checks both for SOL releases).
      balance: async () => 10_000_000_000_000n,
      rentExemptMinimum: async () => 650_240n,
    };
    const env = {
      [GUARDIAN_ENV.authorizationKey]: p256().privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      [GUARDIAN_ENV.walletId]: 'walletid0000000000000001', [GUARDIAN_ENV.address]: keys.guardian, [GUARDIAN_ENV.policyId]: 'policyid0000000000000001',
      [GUARDIAN_ENV.signerId]: 'quorumsigner000000000001', [GUARDIAN_ENV.ownerQuorumId]: 'quorumowner0000000000001',
    };
    const config = readGuardianConfig(env);
    const admin = p256().publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const sends: GuardianSendInput[] = [];
    const failures = { signing: 0 };
    const privy: GuardianPrivyClient = {
      async getWallet(id) {
        return { id, address: keys.guardian, chain_type: 'solana', owner_id: config.ownerQuorumId, policy_ids: [config.policyId], additional_signers: [{ signer_id: config.signerId, override_policy_ids: [config.policyId] }], exported_at: null, imported_at: null, archived_at: null };
      },
      async getKeyQuorum(id) {
        if (id === config.signerId) return { id, authorization_keys: [{ public_key: config.serverPublicKey }], authorization_threshold: 1, user_ids: null };
        if (id === config.ownerQuorumId) return { id, authorization_keys: [{ public_key: config.serverPublicKey }, { public_key: admin }], authorization_threshold: 2, user_ids: null };
        throw new Error('unknown key quorum');
      },
      async signAndSendTransaction(_walletId, input) {
        if (failures.signing > 0) { failures.signing -= 1; throw new Error('Privy is unavailable'); }
        sends.push(input); return { hash: signature(sends.length) };
      },
    };
    const users: Record<string, PrivyUserFacts> = {
      'did:privy:alice': { id: 'did:privy:alice', solanaWallets: [linked(keys.user)] },
      'did:privy:bob': { id: 'did:privy:bob', solanaWallets: [linked(newWallet())] },
      // Carol never enrolled Privy MFA: since 2026-10-13 no vault step needs it.
      'did:privy:carol': { id: 'did:privy:carol', solanaWallets: [linked(carol.user)] },
    };
    let clock = NOW;
    // `hold(user)` parks that account's next Privy lookups until released, to keep a request in flight.
    const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
    const hold = (user: string) => {
      let reached!: () => void, release!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      holds.set(`did:privy:${user}`, { reached, released: new Promise<void>(resolve => { release = resolve; }) });
      return { arrived, release: () => { holds.delete(`did:privy:${user}`); release(); } };
    };
    const loadUser = async (id: string) => {
      const parked = holds.get(id);
      if (parked) { parked.reached(); await parked.released; }
      const user = users[id]; if (!user) throw new Error('unknown user'); return user;
    };
    // As the server opens it (vaultStoreOptions): every reservation needs the layer step's release authorization.
    const store = createVaultStore(join(dir, VAULT_STORE_FILE), { requireReleaseAuthorization: true });
    const guardian = createPairedVaultGuardian({
      guardian: createGuardianSigner({ config, client: privy, latestBlockhash: rpc.latestBlockhash }),
      rpc, cluster: 'mainnet-beta', store, now: () => clock, loadUser, audit: () => {},
    });
    const audits: LayerAuditEvent[] = [];
    // The real layer service on the same store, RPC, Privy facts and clock; passkeys use the development RP ID (localhost).
    // The vault authenticator's sealing key is read from `totpEnv` on every use, so a test can remove it.
    const totpEnv: Record<string, string | undefined> = { [TOTP_KEY_ENV]: Buffer.alloc(32, 7).toString('base64') };
    const layers = createVaultLayerService({
      store, rpc, cluster: 'mainnet-beta', guardian: keys.guardian, now: () => clock, loadUser,
      passkeyConfig: () => layerServerConfig({}), totpKey: () => totpKeyFromEnv(totpEnv), network: { production: false, trustProxy: 1 }, audit: event => { audits.push(event); },
    });
    const factory = { calls: 0, layers: 0 };
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/vault', pairedVaultRouter({
      ...evmDependencies, solanaGuardian: () => { factory.calls += 1; return guardian; }, solanaLayers: () => { factory.layers += 1; return layers; },
    }));
    const setProposal = (index: bigint, lamports: bigint, approved: string[], status: 'Active' | 'Approved' = 'Active') => {
      const addresses = pairedVaultAddresses(keys.multisig, index);
      chain.set(keys.multisig, multisigAccount(keys, { transactionIndex: index > 3n ? index : 3n }));
      chain.set(addresses.proposal!, proposalAccount(keys, { index, approved, status }));
      chain.set(addresses.transaction!, vaultTransactionAccount(keys, { index, instructions: [{ kind: 'sol', to: keys.user, lamports }] }));
    };
    const as = (user: string) => ({ Authorization: `Bearer did:privy:${user}` });
    const authenticator = createTestAuthenticator({ rpId: 'localhost', origin: 'http://localhost:1420' });
    // Every request comes from one public address unless a test says otherwise (trust proxy is one hop here).
    const post = (user: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
      request(app).post(`/vault/solana/${path}`).set(as(user)).set('X-Forwarded-For', '203.0.113.7').set(headers).send(body as object);
    /** Enrolls a passkey (the first one applies at once) and returns it. */
    const enrollPasskey = async (user = 'alice', label = 'Laptop') => {
      const begin = (await post(user, 'layers/enroll/begin', { multisig: keys.multisig, op: { type: 'passkey.add', label } }).expect(200)).body;
      const { response, passkey } = authenticator.register({ challenge: begin.webauthn.create.challenge, counter: 1 });
      const finish = await post(user, 'layers/enroll/finish', { multisig: keys.multisig, challengeId: begin.challengeId, registration: response });
      return { passkey, begin, finish };
    };
    /** Approval evidence: begin, then a passkey assertion for that exact release. */
    const evidence = async (user: string, transactionIndex: string, passkey: TestPasskey, options: { uv?: boolean } = {}) => {
      const begin = (await post(user, 'layers/approval/begin', { multisig: keys.multisig, transactionIndex }).expect(200)).body;
      return { begin, layers: { challengeId: begin.challengeId, passkey: authenticator.assert(passkey, { challenge: begin.webauthn.challenge, uv: options.uv }) } };
    };
    return {
      keys, carol, chain, reads, sends, users, factory, app, setProposal, as, hold, authKey: env[GUARDIAN_ENV.authorizationKey], store, audits, failures,
      authenticator, post, enrollPasskey, evidence, file: join(dir, VAULT_STORE_FILE), guardian, totpEnv,
      advance: (ms: number) => { clock += ms; }, now: () => clock, cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  const layerRoutes = [
    ['get', '/vault/solana/layers'], ['post', '/vault/solana/layers/approval/begin'], ['post', '/vault/solana/layers/enroll/begin'], ['post', '/vault/solana/layers/enroll/finish'],
    ['post', '/vault/solana/layers/change/begin'], ['post', '/vault/solana/layers/change/finish'], ['post', '/vault/solana/layers/change/cancel'],
  ] as const;
  const routes = [['get', '/vault/solana/config'], ['get', '/vault/solana/account'], ['get', '/vault/solana/vaults'], ['get', '/vault/limits'], ['post', '/vault/solana/register'], ['post', '/vault/solana/approve'], ...layerRoutes] as const;

  it('requires a Privy session before every Solana route and builds no guardian for an anonymous caller', async () => {
    const s = solanaRoutes();
    try {
      for (const [method, path] of routes) {
        await request(s.app)[method](path).expect(401);
        await request(s.app)[method](path).set('Authorization', 'Bearer not-a-privy-token').expect(401);
      }
      assert.equal(s.factory.calls, 0); assert.equal(s.factory.layers, 0); assert.equal(s.reads.accounts, 0);
    } finally { s.cleanup(); }
  });

  it('reports an unprovisioned guardian as 503 without naming or echoing settings', async () => {
    const app = express();
    app.use(express.json());
    app.use('/missing', pairedVaultRouter(evmDependencies));
    app.use('/unprovisioned', pairedVaultRouter({ ...evmDependencies, solanaGuardian: () => { throw new GuardianNotProvisionedError(); } }));
    for (const base of ['/missing', '/unprovisioned']) {
      for (const [method, path] of routes) {
        const response = await request(app)[method](path.replace('/vault', base)).set('Authorization', 'Bearer did:privy:alice').send({}).expect(503);
        assert.deepEqual(response.body, { error: GUARDIAN_NOT_PROVISIONED, code: 'not-provisioned' });
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
    const saved = Object.fromEntries([...Object.values(GUARDIAN_ENV), PAIRED_VAULTS_ENABLED_ENV].map(name => [name, process.env[name]]));
    try {
      for (const name of Object.values(GUARDIAN_ENV)) delete process.env[name];
      process.env[PAIRED_VAULTS_ENABLED_ENV] = 'true';
      assert.throws(() => defaultSolanaGuardian(), GuardianNotProvisionedError);
      // With every guardian setting present, the owner switch still keeps paired vaults off until it is exactly "true".
      for (const name of Object.values(GUARDIAN_ENV)) process.env[name] = 'set';
      for (const value of [undefined, '', 'false', '1', 'yes', 'TRUE']) {
        if (value === undefined) delete process.env[PAIRED_VAULTS_ENABLED_ENV]; else process.env[PAIRED_VAULTS_ENABLED_ENV] = value;
        assert.equal(pairedVaultsEnabled(), false, String(value));
        assert.throws(() => defaultSolanaGuardian(), GuardianNotProvisionedError, String(value));
      }
      assert.equal(pairedVaultsEnabled({ [PAIRED_VAULTS_ENABLED_ENV]: ' true ' }), true);
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('maps guardian refusals to their status and never leaks unexpected error text', async () => {
    const failing = (error: Error) => ({ config: async () => { throw error; } }) as unknown as PairedVaultGuardian;
    for (const [error, status, code] of [
      [new GuardianError('Denied.', 403, 'denied'), 403, 'denied'], [new GuardianError('Busy.', 409, 'conflict'), 409, 'conflict'],
      [new GuardianError('Slow down.', 429, 'busy'), 429, 'busy'], [new GuardianError('Down.', 503, 'unavailable'), 503, 'unavailable'],
      [new Error('https://rpc.example/secret-key leaked'), 503, 'unavailable'],
    ] as const) {
      const app = express();
      app.use('/vault', pairedVaultRouter({ ...evmDependencies, solanaGuardian: () => failing(error) }));
      const response = await request(app).get('/vault/solana/config').set('Authorization', 'Bearer did:privy:alice').expect(status);
      assert.equal(response.body.code, code); assert.doesNotMatch(JSON.stringify(response.body), /secret-key/);
      if (status === 429) assert.equal(response.headers['retry-after'], '60');
    }
  });

  it('serves the pinned guardian (no server-wide limits) and this account’s facts', async () => {
    const s = solanaRoutes();
    try {
      const config = await request(s.app).get('/vault/solana/config').set(s.as('alice')).expect(200);
      assert.equal(config.body.configured, true); assert.equal(config.body.guardian, s.keys.guardian);
      assert.equal(config.body.policyVersion, 'antara-paired-solana-v1'); assert.equal(config.body.cluster, 'mainnet-beta');
      // Owner decision 2026-10-13: no default cap, ceiling or minimum is published or applied.
      assert.equal('limits' in config.body, false);
      assert.doesNotMatch(JSON.stringify(config.body), new RegExp(s.authKey.slice(0, 40).replace(/[+/]/g, '.')));
      const account = await request(s.app).get('/vault/solana/account').set(s.as('alice')).expect(200);
      // Every linked wallet can receive releases as soon as it is linked: no link-age field or wait.
      assert.deepEqual(account.body, { mfaEnrolled: true, vaults: [], wallets: [{ address: s.keys.user, embedded: true, pairProblem: null }] });
      // `mfaEnrolled` is a compatibility field: always true, because no account-level MFA is required.
      assert.equal((await request(s.app).get('/vault/solana/account').set(s.as('carol')).expect(200)).body.mfaEnrolled, true);
      // /limits is per vault: it needs the caller's own registered vault.
      assert.equal((await request(s.app).get('/vault/limits').set(s.as('alice')).expect(400)).body.code, 'invalid');
      assert.equal((await request(s.app).get('/vault/limits').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(409)).body.code, 'conflict');
    } finally { s.cleanup(); }
  });

  it('registers only an exact paired vault of the caller’s own wallet, without any Privy MFA', async () => {
    const s = solanaRoutes();
    try {
      // No Privy MFA (owner decision 2026-10-13): Carol's exact paired vault registers.
      const noMfa = await request(s.app).post('/vault/solana/register').set(s.as('carol')).send({ multisig: s.carol.multisig }).expect(200);
      assert.equal(noMfa.body.status, 'registered');
      // Another account's wallet is not the caller's.
      const foreign = await request(s.app).post('/vault/solana/register').set(s.as('bob')).send({ multisig: s.keys.multisig }).expect(403);
      assert.match(foreign.body.error, /not paired with a wallet linked to your account/);
      // Anything but exactly {U:7, G:2}, threshold 2, no config authority, is refused.
      const original = s.chain.get(s.keys.multisig)!;
      for (const [options, reason] of [
        [{ members: [{ key: s.keys.user, mask: 7 }, { key: s.keys.guardian, mask: 7 }] }, /vote permission only/],
        [{ members: [{ key: s.keys.user, mask: 3 }, { key: s.keys.guardian, mask: 2 }] }, /initiate, vote and execute/],
        [{ members: [{ key: s.keys.user, mask: 7 }, { key: s.keys.guardian, mask: 2 }, { key: newWallet(), mask: 7 }] }, /exactly two members/],
        [{ members: [{ key: s.keys.user, mask: 7 }, { key: newWallet(), mask: 2 }] }, /guardian is not a member/],
        [{ threshold: 1 }, /exactly two approvals/],
        [{ configAuthority: newWallet() }, /configuration authority/],
      ] as Array<[MultisigFixtureOptions, RegExp]>) {
        s.chain.set(s.keys.multisig, multisigAccount(s.keys, options));
        const refused = await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(403);
        assert.match(refused.body.error, reason);
      }
      assert.deepEqual((await request(s.app).get('/vault/solana/vaults').set(s.as('alice')).expect(200)).body, { vaults: [] });
      s.chain.set(s.keys.multisig, original);
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: 'not-a-vault' }).expect(400);
      const registered = await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      assert.deepEqual(registered.body, { status: 'registered', multisig: s.keys.multisig, vault: s.keys.vault, guardian: s.keys.guardian });
      assert.equal((await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200)).body.status, 'already-registered');
      assert.deepEqual((await request(s.app).get('/vault/solana/account').set(s.as('alice')).expect(200)).body.vaults.map((item: { multisig: string }) => item.multisig), [s.keys.multisig]);
      assert.equal(s.sends.length, 0, 'registration never signs');
    } finally { s.cleanup(); }
  });

  it('approves a release once, answers repeats without a second vote, applies no default cap, and denies foreign requests', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: 1 }).expect(400);
      const { layers } = await s.evidence('alice', '1', passkey);
      const approved = await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: '1', layers }).expect(200);
      assert.deepEqual(approved.body, { status: 'approved', signature: signature(1), asset: 'SOL', amountRaw: '300000000', recipient: s.keys.user });
      assert.equal(s.sends.length, 1);
      // A retry while the vote may still land is answered from the ledger.
      assert.deepEqual((await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: '1' }).expect(200)).body, { status: 'pending', signature: signature(1) });
      // Once G's vote is on-chain, a retry is answered without signing.
      s.setProposal(1n, 300_000_000n, [s.keys.user, s.keys.guardian], 'Approved');
      s.advance(5 * 60 * 1000);
      assert.deepEqual((await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: '1' }).expect(200)).body, { status: 'already-approved' });
      assert.equal(s.sends.length, 1, 'no second vote');
      assert.deepEqual((await request(s.app).get('/vault/limits').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body, {
        multisig: s.keys.multisig, limits: { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } }, usedLast24h: { SOL: '300000000', USDC: '0' },
      });
      // No default cap (owner decision 2026-10-13): 600 SOL, far above the old 0.5 SOL and 2 SOL per day, only needs the layers.
      s.setProposal(2n, 600_000_000_000n, [s.keys.user]);
      const noCap = await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: '2' }).expect(403);
      assert.equal(noCap.body.code, 'layers-required');
      const large = await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: s.keys.multisig, transactionIndex: '2', layers: (await s.evidence('alice', '2', passkey)).layers }).expect(200);
      assert.deepEqual([large.body.status, large.body.amountRaw], ['approved', '600000000000']);
      // Another account cannot ask G to vote on this vault.
      s.setProposal(3n, 100_000_000n, [s.keys.user]);
      assert.match((await request(s.app).post('/vault/solana/approve').set(s.as('bob')).send({ multisig: s.keys.multisig, transactionIndex: '3' }).expect(403)).body.error, /another account/);
      assert.equal(s.sends.length, 2, 'nothing else was signed');
    } finally { s.cleanup(); }
  });

  it('never lets another account’s in-flight request block the owner’s approval of a public proposal', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      // Bob's request for Alice's (public) multisig and index is parked mid-flight.
      const parked = s.hold('bob');
      const foreign = request(s.app).post('/vault/solana/approve').set(s.as('bob')).send(body).then(response => response);
      await parked.arrived;
      const approved = await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ ...body, layers: (await s.evidence('alice', '1', passkey)).layers }).expect(200);
      assert.equal(approved.body.status, 'approved');
      parked.release();
      assert.match((await foreign).body.error, /another account/);
      assert.equal((await foreign).status, 403);
      assert.equal(s.sends.length, 1, 'exactly one vote');
      // The owner's own concurrent requests for one proposal are still serialised.
      s.setProposal(2n, 100_000_000n, [s.keys.user]);
      const { layers } = await s.evidence('alice', '2', passkey);
      const ownParked = s.hold('alice');
      const first = request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ ...body, transactionIndex: '2', layers }).then(response => response);
      await ownParked.arrived;
      assert.equal((await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ ...body, transactionIndex: '2' }).expect(409)).body.code, 'conflict');
      // So are approvals of the account's other proposals: the layer step checks any caps the user set against existing reservations.
      assert.equal((await request(s.app).post('/vault/solana/approve').set(s.as('alice')).send({ ...body, transactionIndex: '3' }).expect(409)).body.code, 'conflict');
      ownParked.release();
      assert.equal((await first).status, 200);
      assert.equal(s.sends.length, 2);
    } finally { s.cleanup(); }
  });

  it('opens the vault store once when the router is built, without touching the guardian', async () => {
    let opened = 0, built = 0;
    pairedVaultRouter({ ...evmDependencies, solanaGuardian: () => { built += 1; throw new GuardianNotProvisionedError(); }, initialiseStore: () => { opened += 1; } });
    assert.equal(opened, 1); assert.equal(built, 0);
    const disk = mkdtempSync(join(tmpdir(), 'antara-boot-route-'));
    const errors: string[] = [], infos: string[] = [];
    const error = console.error, info = console.info;
    console.error = (line: string) => { errors.push(line); }; console.info = (line: string) => { infos.push(line); };
    try {
      assert.equal(openVaultStoreAtBoot({ NODE_ENV: 'production', DATA_DIR: disk }).outcome, 'refused');
      assert.equal(openVaultStoreAtBoot({ NODE_ENV: 'production', DATA_DIR: disk, ANTARA_VAULT_STORE_INIT: '1' }).outcome, 'initialised');
      assert.equal(openVaultStoreAtBoot({ NODE_ENV: 'production', DATA_DIR: disk }).outcome, 'ready');
    } finally { console.error = error; console.info = info; rmSync(disk, { recursive: true, force: true }); }
    assert.deepEqual([...errors, ...infos].map(line => JSON.parse(line).outcome), ['refused', 'initialised', 'ready']);
    assert.ok([...errors, ...infos].every(line => JSON.parse(line).event === 'antara.vault-store' && !line.includes(disk.replace(/\\/g, '\\\\'))));
  });

  it('rate limits register and approve per account', async () => {
    const s = solanaRoutes();
    const server = s.app.listen(0);
    try {
      for (let i = 0; i < 10; i++) await request(server).post('/vault/solana/approve').set(s.as('alice')).send({ multisig: 'x' }).expect(400);
      const limited = await request(server).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(429);
      assert.equal(limited.body.code, 'RATE_LIMITED'); assert.equal(limited.headers['retry-after'], '60');
      await request(server).post('/vault/solana/approve').set(s.as('bob')).send({ multisig: 'x' }).expect(400);
      await request(server).get('/vault/solana/config').set(s.as('alice')).expect(200);
    } finally { server.close(); s.cleanup(); }
  });
  // ---------------------------------------------------------------------------
  // Vault protection layers (docs/VAULT_LAYERS.md)
  // ---------------------------------------------------------------------------
  type Harness = ReturnType<typeof solanaRoutes>;
  const devicePayload = (s: Harness, begin: { purpose: string; challengeId: string; nonce: string; digest: string }, device: { keyId: string; surface: string }, extra: Record<string, unknown> = {}) =>
    ({ v: 1, purpose: begin.purpose, challengeId: begin.challengeId, nonce: begin.nonce, digest: begin.digest, keyId: device.keyId, surface: device.surface, signedAt: s.now(), ...extra });
  const PHONE = { identifier: 'cGhvbmUtaWQtMDAwMQ==', name: 'Pixel 9' };
  const HOME = { lat: 48.8566, lng: 2.3522 };
  /** Registers Alice's vault and enrolls a passkey, a trusted browser key, a place, the current network and a Bluetooth device (each turns a layer on, so each applies at once). */
  async function protectedVault(s: Harness) {
    await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
    const { passkey, finish } = await s.enrollPasskey();
    assert.deepEqual(finish.body, { status: 'applied', configVersion: 1 });
    const device = createTestDevice('web');
    const enroll = async (op: Record<string, unknown>, extra: (begin: { purpose: string; challengeId: string; nonce: string; digest: string }) => Record<string, unknown> = () => ({})) => {
      const begin = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op }).expect(200)).body;
      assert.equal(begin.class, 'tighten'); assert.equal(begin.effectiveAt, null);
      const done = await s.post('alice', 'layers/enroll/finish', {
        multisig: s.keys.multisig, challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.get.challenge }), ...extra(begin),
      }).expect(200);
      assert.equal(done.body.status, 'applied');
      return begin;
    };
    await enroll({ type: 'device.add', label: 'Browser', surface: 'web', publicKeySpki: device.publicKeySpki }, begin => ({ device: device.evidence(devicePayload(s, begin, device)) }));
    const zone = await enroll({ type: 'geolocation.add-zone', label: 'Home', radiusM: 1000, center: 'current' },
      begin => ({ device: device.evidence(devicePayload(s, begin, device, { geo: { ...HOME, accuracyM: 30, at: s.now(), source: 'browser-geolocation' } })) }));
    assert.deepEqual(zone.capture, { geo: true });
    const network = await enroll({ type: 'wifi.add-network', label: 'Home' });
    assert.deepEqual(network.capture, { network: { observedCidr: 'IPv4 203.0.x.x/32' } });
    await enroll({ type: 'bluetooth.add-device', label: 'Phone' },
      begin => ({ device: device.evidence(devicePayload(s, begin, device, { bluetooth: { devices: [PHONE], at: s.now(), source: 'web-bluetooth' } })) }));
    return { passkey, device };
  }

  it('answers 503 not-provisioned for every layer route and every vote without the layer service', async () => {
    const s = solanaRoutes();
    try {
      const app = express();
      app.use(express.json());
      app.use('/vault', pairedVaultRouter({ ...evmDependencies, solanaGuardian: () => createPairedVaultGuardian({
        guardian: { address: s.keys.guardian, verify: async () => {}, approve: async () => { throw new Error('never'); } },
        rpc: { genesisHash: async () => '', accounts: async () => [], countSpendingLimits: async () => 0, latestBlockhash: async () => '' },
        cluster: 'mainnet-beta', store: s.store, loadUser: async () => { throw new Error('never'); }, audit: () => {},
      }) }));
      for (const [method, path] of [...layerRoutes, ['post', '/vault/solana/approve'] as const]) {
        const response = await request(app)[method](path).set(s.as('alice')).send({}).expect(503);
        assert.equal(response.body.code, 'not-provisioned', path);
      }
    } finally { s.cleanup(); }
  });

  it('requires a passkey for every release, verifies it for this exact release and votes once', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      // No passkey yet: releases are paused and the status says so.
      for (const path of ['approve', 'layers/approval/begin']) {
        const paused = await s.post('alice', path, body).expect(403);
        assert.deepEqual(paused.body, { error: paused.body.error, code: 'layer-failed', layers: [{ id: 'biometrics', ok: false, reason: paused.body.error }] });
        assert.match(paused.body.error, /Add a passkey/);
      }
      const before = (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body;
      assert.deepEqual(before.layers.find((layer: { id: string }) => layer.id === 'biometrics'), { id: 'biometrics', kinds: ['cryptographic'], status: 'not-enrolled', enforced: true, items: [] });
      assert.equal(before.configVersion, 0);
      const { passkey } = await s.enrollPasskey();
      // Without evidence: the requirement list, and nothing reserved or signed.
      const required = await s.post('alice', 'approve', body).expect(403);
      assert.deepEqual(required.body, {
        error: 'This vault has protection layers on. Verify them to approve this release.', code: 'layers-required',
        required: [{ id: 'biometrics', evidence: 'passkey' }],
      });
      assert.equal(s.store.ledger().length, 0); assert.equal(s.sends.length, 0);
      const begin = (await s.post('alice', 'layers/approval/begin', body).expect(200)).body;
      assert.deepEqual(begin.release, { multisig: s.keys.multisig, transactionIndex: '1', asset: 'SOL', amountRaw: '300000000', recipient: s.keys.user });
      assert.equal(begin.purpose, 'release'); assert.equal(begin.configVersion, 1); assert.match(begin.digest, /^[0-9a-f]{64}$/);
      assert.equal(begin.webauthn.rpId, 'localhost'); assert.equal(begin.webauthn.userVerification, 'required'); assert.equal(begin.webauthn.allowCredentials.length, 1);
      // A failed assertion (no user verification) consumes the challenge; replaying it is refused.
      const noUv = await s.post('alice', 'approve', { ...body, layers: { challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.challenge, uv: false }) } }).expect(403);
      assert.equal(noUv.body.code, 'layer-failed'); assert.deepEqual(noUv.body.layers.map((layer: { id: string; ok: boolean }) => [layer.id, layer.ok]), [['biometrics', false]]);
      const replay = await s.post('alice', 'approve', { ...body, layers: { challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.challenge }) } }).expect(403);
      assert.deepEqual(replay.body, { error: 'This verification request is invalid or expired. Start again.', code: 'challenge-invalid' });
      assert.equal(s.store.ledger().length, 0); assert.equal(s.sends.length, 0);
      // A challenge from another Privy session is refused (the service's binding; in production this needs requirePrivyUser
      // to record verifyAccessToken().session_id, and without it every layer route refuses: see the missing-session test).
      const other = await s.evidence('alice', '1', passkey);
      assert.equal((await s.post('alice', 'approve', { ...body, layers: other.layers }, { 'X-Test-Session': 'session-b' }).expect(403)).body.code, 'challenge-invalid');
      const { layers } = await s.evidence('alice', '1', passkey);
      const approved = await s.post('alice', 'approve', { ...body, layers }).expect(200);
      assert.equal(approved.body.status, 'approved'); assert.equal(s.sends.length, 1);
      const entry = s.store.ledgerEntry(s.keys.multisig, '1');
      assert.deepEqual({ ...entry?.layers, passedAt: undefined }, { challengeId: layers.challengeId, configVersion: 1, passedAt: undefined, enforced: ['biometrics'] });
      // The verified counter is stored (registered at 1; assertions 2 to 4 were refused before or during verification, 5 passed).
      assert.equal(s.store.layerConfig(s.keys.multisig)?.biometrics?.credentials[0].counter, 5);
      assert.equal(JSON.stringify(s.store.layerConfig(s.keys.multisig)).includes('203.0.113'), false);
    } finally { s.cleanup(); }
  });

  it('checks every enrolled layer, denies when any one fails without reserving, and never shows stored values', async () => {
    const s = solanaRoutes();
    try {
      const { passkey, device } = await protectedVault(s);
      const view = (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).set('X-Forwarded-For', '203.0.113.7').expect(200)).body;
      assert.deepEqual(view.layers.map((layer: { id: string; status: string; enforced: boolean }) => [layer.id, layer.status, layer.enforced]), [
        ['bluetooth', 'enrolled', true], ['wifi', 'enrolled', true], ['biometrics', 'enrolled', true], ['geolocation', 'enrolled', true], ['mfa', 'not-enrolled', false], ['limits', 'not-enrolled', false],
      ]);
      assert.deepEqual(view.network, { observed: true, trusted: true }); assert.equal(view.configVersion, 5);
      assert.deepEqual(view.devices.map((item: { surface: string; state: string }) => [item.surface, item.state]), [['web', 'active']]);
      const text = JSON.stringify(view);
      for (const hidden of ['48.85', '2.352', '203.0.113.7', PHONE.identifier, device.publicKeySpki.slice(0, 24)]) assert.equal(text.includes(hidden), false, hidden);
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      const attempt = async (options: { uv?: boolean; geo?: Record<string, unknown>; bluetooth?: Record<string, unknown>; ip?: string } = {}) => {
        const begin = (await s.post('alice', 'layers/approval/begin', body).expect(200)).body;
        assert.deepEqual(begin.required.map((item: { id: string }) => item.id), ['biometrics', 'geolocation', 'wifi', 'bluetooth']);
        assert.deepEqual(begin.required[3].match, [{ surface: 'web', source: 'web-bluetooth', ...PHONE }]);
        const payload = devicePayload(s, begin, device, {
          geo: { ...HOME, accuracyM: 25, at: s.now(), source: 'browser-geolocation', ...options.geo },
          bluetooth: { devices: [PHONE], at: s.now(), source: 'web-bluetooth', ...options.bluetooth },
        });
        return s.post('alice', 'approve', {
          ...body, layers: { challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.challenge, uv: options.uv }), device: device.evidence(payload) },
        }, { 'X-Forwarded-For': options.ip ?? '203.0.113.7' });
      };
      const failing = async (options: Parameters<typeof attempt>[0], layer: string, reason: RegExp) => {
        const response = await attempt(options);
        assert.equal(response.status, 403); assert.equal(response.body.code, 'layer-failed');
        assert.deepEqual(response.body.layers.filter((item: { ok: boolean }) => !item.ok).map((item: { id: string }) => item.id), [layer]);
        assert.match(response.body.layers.find((item: { id: string }) => item.id === layer).reason, reason);
        assert.equal(s.store.ledger().length, 0, 'nothing reserved'); assert.equal(s.sends.length, 0, 'nothing signed');
      };
      await failing({ uv: false }, 'biometrics', /passkey/);
      await failing({ geo: { lat: HOME.lat + 0.5 } }, 'geolocation', /outside your safe zones/);
      await failing({ ip: '198.51.100.9' }, 'wifi', /trusted networks/);
      await failing({ bluetooth: { devices: [{ identifier: 'b3RoZXItZGV2aWNl', name: 'Other' }] } }, 'bluetooth', /Bluetooth device was not found/);
      const approved = await attempt();
      assert.equal(approved.status, 200); assert.equal(approved.body.status, 'approved'); assert.equal(s.sends.length, 1);
      assert.deepEqual(s.store.ledgerEntry(s.keys.multisig, '1')?.layers?.enforced, ['bluetooth', 'wifi', 'biometrics', 'geolocation']);
      // Audit lines name layers and outcomes only: never readings, addresses, identifiers or keys.
      const lines = JSON.stringify(s.audits);
      for (const hidden of ['48.8', '203.0.113', '198.51.100', PHONE.identifier, 'Pixel', device.publicKeySpki.slice(0, 24), passkey.id]) assert.equal(lines.includes(hidden), false, hidden);
      assert.ok(s.audits.some(event => event.action === 'approve' && event.outcome === 'denied' && event.layers?.some(layer => layer.id === 'geolocation' && !layer.ok)));
    } finally { s.cleanup(); }
  });

  it('refuses a challenge after the transaction or the configuration changed (challenge-stale)', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      const first = await s.evidence('alice', '1', passkey);
      s.setProposal(1n, 200_000_000n, [s.keys.user]);
      const changedTransaction = await s.post('alice', 'approve', { ...body, layers: first.layers }).expect(409);
      assert.deepEqual(changedTransaction.body, { error: 'The vault or its protection layers changed after verification started. Start again.', code: 'challenge-stale' });
      const second = await s.evidence('alice', '1', passkey);
      // Setting a cap (Limits was off) is a tightening and changes the configuration version.
      const change = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'limits.set', perReleaseRaw: { SOL: '400000000', USDC: null }, perDayRaw: { SOL: null, USDC: null } } }).expect(200)).body;
      assert.equal(change.class, 'tighten'); assert.equal(change.capture, undefined); assert.equal(change.webauthn.create, null);
      await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: change.challengeId, passkey: s.authenticator.assert(passkey, { challenge: change.webauthn.get.challenge }) }).expect(200);
      assert.equal((await s.post('alice', 'approve', { ...body, layers: second.layers }).expect(409)).body.code, 'challenge-stale');
      assert.equal(s.store.ledger().length, 0);
      // The cap the user set now applies: 0.2 SOL is under it, 0.45 SOL is over the vault's 0.4 SOL.
      s.setProposal(2n, 450_000_000n, [s.keys.user]);
      assert.match((await s.post('alice', 'layers/approval/begin', { ...body, transactionIndex: '2' }).expect(403)).body.error, /per-release limit you set/);
      const third = await s.evidence('alice', '1', passkey);
      assert.deepEqual(third.begin.required.map((item: { id: string }) => item.id), ['biometrics', 'limits']);
      assert.equal((await s.post('alice', 'approve', { ...body, layers: third.layers }).expect(200)).body.status, 'approved');
      assert.deepEqual(s.store.ledgerEntry(s.keys.multisig, '1')?.layers?.enforced, ['biometrics', 'limits']);
      const view = (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body.layers.at(-1);
      assert.deepEqual([view.status, view.enforced, view.limits], ['enrolled', true, { perReleaseRaw: { SOL: '400000000', USDC: null }, perDayRaw: { SOL: null, USDC: null } }]);
      assert.deepEqual((await request(s.app).get('/vault/limits').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body, {
        multisig: s.keys.multisig, limits: view.limits, usedLast24h: { SOL: '200000000', USDC: '0' },
      });
      assert.equal((await request(s.app).get('/vault/limits').query({ multisig: s.keys.multisig }).set(s.as('bob')).expect(403)).body.code, 'denied');
      // Turning Limits off is a loosening: it needs every layer that is on (here the passkey) and applies at once.
      const off = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'limits' } }).expect(200)).body;
      assert.deepEqual([off.class, off.effectiveAt, off.required], ['loosen', null, [{ id: 'biometrics', evidence: 'passkey' }]]);
      assert.equal((await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: off.challengeId }).expect(403)).body.code, 'layer-failed', 'not without the current layers');
      const off2 = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'limits' } }).expect(200)).body;
      assert.equal((await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: off2.challengeId, passkey: s.authenticator.assert(passkey, { challenge: off2.webauthn.get.challenge }) }).expect(200)).body.status, 'applied');
      assert.equal((await s.post('alice', 'layers/approval/begin', { ...body, transactionIndex: '2' }).expect(200)).body.release.amountRaw, '450000000');
    } finally { s.cleanup(); }
  });

  it('re-signs a passed reservation without new evidence for 30 minutes at the same configuration only', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      const fail = async (index: string) => {
        s.setProposal(BigInt(index), 100_000_000n, [s.keys.user]);
        s.failures.signing = 1;
        const { layers } = await s.evidence('alice', index, passkey);
        assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: index, layers }).expect(503)).body.code, 'unavailable');
        assert.equal(s.store.ledgerEntry(s.keys.multisig, index)?.layers?.configVersion, s.store.layerConfig(s.keys.multisig)?.version, 'the pass is recorded on the reservation');
      };
      await fail('1');
      s.advance(29 * 60 * 1000);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '1' }).expect(200)).body.status, 'approved');
      await fail('2');
      s.advance(30 * 60 * 1000);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '2' }).expect(403)).body.code, 'layers-required', 'after 30 minutes');
      await fail('3');
      const tighten = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'limits.set', perReleaseRaw: { SOL: '400000000', USDC: '50000000' }, perDayRaw: { SOL: '2000000000', USDC: '200000000' } } }).expect(200)).body;
      assert.equal(tighten.class, 'tighten');
      await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: tighten.challengeId, passkey: s.authenticator.assert(passkey, { challenge: tighten.webauthn.get.challenge }) }).expect(200);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '3' }).expect(403)).body.code, 'layers-required', 'after a configuration change');
      assert.equal(s.sends.length, 1);
    } finally { s.cleanup(); }
  });

  it('locks a vault’s evidence-bearing routes after 5 failed checks', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      for (let i = 0; i < 5; i++) {
        const { layers } = await s.evidence('alice', '1', passkey, { uv: false });
        assert.equal((await s.post('alice', 'approve', { ...body, layers }).expect(403)).body.code, 'layer-failed');
      }
      const locked = await s.post('alice', 'layers/approval/begin', body).expect(429);
      // The wait is in the header and the body: a cross-origin client may be unable to read the header.
      assert.deepEqual(locked.body, { error: 'Too many failed protection checks for this vault. Try again later.', code: 'locked', retryAfterSeconds: 900 });
      assert.equal(locked.headers['retry-after'], '900');
      assert.equal((await s.post('alice', 'approve', { ...body, layers: { challengeId: 'A'.repeat(22) } }).expect(429)).body.code, 'locked');
      assert.equal((await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'wifi.add-network', label: 'x' } }).expect(429)).body.code, 'locked');
      assert.equal(s.sends.length, 0);
      assert.ok(s.audits.some(event => event.outcome === 'locked'));
      s.advance(15 * 60 * 1000);
      await s.post('alice', 'layers/approval/begin', body).expect(200);
    } finally { s.cleanup(); }
  });

  it('applies loosening at once after every current layer passes, and keeps only recovery changes pending and cancelable', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      const network = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'wifi.add-network', label: 'Home', prefixLength: 24 } }).expect(200)).body;
      assert.deepEqual(network.capture, { network: { observedCidr: 'IPv4 203.0.x.x/24' } });
      await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: network.challengeId, passkey: s.authenticator.assert(passkey, { challenge: network.webauthn.get.challenge }) }).expect(200);
      const begin = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'wifi' } }).expect(200)).body;
      // Owner decision 2026-10-13: no 24-hour wait.
      assert.equal(begin.class, 'loosen'); assert.equal(begin.effectiveAt, null);
      assert.deepEqual(begin.required, [{ id: 'biometrics', evidence: 'passkey' }, { id: 'wifi', evidence: 'server' }]);
      // Loosening needs every enabled layer: from another network the Wi-Fi layer fails.
      const elsewhere = await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.get.challenge }) }, { 'X-Forwarded-For': '198.51.100.9' }).expect(403);
      assert.deepEqual(elsewhere.body.layers.map((item: { id: string; ok: boolean }) => [item.id, item.ok]), [['wifi', false], ['biometrics', true]]);
      const again = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'wifi' } }).expect(200)).body;
      const get = async () => (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).set('X-Forwarded-For', '203.0.113.7').expect(200)).body;
      const before = await get();
      const turnedOff = (await s.post('alice', 'layers/change/finish', { multisig: s.keys.multisig, challengeId: again.challengeId, passkey: s.authenticator.assert(passkey, { challenge: again.webauthn.get.challenge }) }).expect(200)).body;
      assert.deepEqual(turnedOff, { status: 'applied', configVersion: before.configVersion + 1 });
      const after = await get();
      assert.equal(after.layers.find((layer: { id: string }) => layer.id === 'wifi').status, 'not-enrolled');
      assert.deepEqual(after.pending, []);
      // Off at once: the next release needs only the passkey.
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      assert.deepEqual((await s.post('alice', 'layers/approval/begin', { multisig: s.keys.multisig, transactionIndex: '1' }).expect(200)).body.required.map((item: { id: string }) => item.id), ['biometrics']);
      // A second passkey is a loosening: it needs the current passkey and applies at once.
      const add = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Phone' } }).expect(200)).body;
      assert.equal(add.class, 'loosen'); assert.equal(add.effectiveAt, null); assert.ok(add.webauthn.get); assert.equal(add.webauthn.create.excludeCredentials.length, 1);
      const phone = s.authenticator.register({ challenge: add.webauthn.create.challenge });
      const added = (await s.post('alice', 'layers/enroll/finish', {
        multisig: s.keys.multisig, challengeId: add.challengeId, registration: phone.response, passkey: s.authenticator.assert(passkey, { challenge: add.webauthn.get.challenge }),
      }).expect(200)).body;
      assert.deepEqual(added, { status: 'applied', configVersion: after.configVersion + 1 });
      assert.deepEqual((await get()).layers.find((layer: { id: string }) => layer.id === 'biometrics').items.map((item: { label: string; state: string }) => [item.label, item.state]), [['Laptop', 'active'], ['Phone', 'active']]);
      // Only a recovery change (a lost device) is pending: a passkey added without the current one waits 7 days and is cancelable.
      const lost = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Tablet' }, waive: ['biometrics'] }).expect(200)).body;
      assert.equal(lost.class, 'recovery'); assert.equal(lost.effectiveAt, new Date(s.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
      const tablet = s.authenticator.register({ challenge: lost.webauthn.create.challenge });
      const queued = (await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: lost.challengeId, registration: tablet.response }).expect(200)).body;
      assert.equal(queued.status, 'pending'); assert.equal(queued.change.class, 'recovery');
      const withTablet = await get();
      const items = withTablet.layers.find((layer: { id: string }) => layer.id === 'biometrics').items;
      assert.deepEqual(items.map((item: { label: string; state: string }) => [item.label, item.state]), [['Laptop', 'active'], ['Phone', 'active'], ['Tablet', 'pending-addition']]);
      // The summary is ANTARA's fixed text; the user's label comes apart, so no label can make a client drop the pending list.
      assert.deepEqual(withTablet.pending.map((item: { summary: string; label?: string }) => [item.summary, item.label]), [['Add a passkey', 'Tablet']]);
      // New labels that look like an address, a device ID or coordinates are refused before anything is issued.
      for (const label of ['Backup 10.0.0.1', 'Key 001A7DDA7113', 'Cabin 48.8566, 2.3522']) {
        assert.equal((await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label } }).expect(400)).body.code, 'invalid', label);
      }
      // The phone passkey works at once; the pending recovery passkey cannot approve anything before it takes effect.
      s.setProposal(2n, 100_000_000n, [s.keys.user]);
      const early = await s.evidence('alice', '2', tablet.passkey);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '2', layers: early.layers }).expect(403)).body.code, 'layer-failed');
      const viaPhone = await s.evidence('alice', '2', phone.passkey);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '2', layers: viaPhone.layers }).expect(200)).body.status, 'approved');
      // Cancelling needs only the session.
      assert.deepEqual((await s.post('alice', 'layers/change/cancel', { multisig: s.keys.multisig, changeId: queued.change.id }).expect(200)).body, { status: 'cancelled', configVersion: withTablet.configVersion + 1 });
      assert.deepEqual((await get()).pending, []);
      assert.equal((await s.post('alice', 'layers/change/cancel', { multisig: s.keys.multisig, changeId: queued.change.id }).expect(409)).body.code, 'conflict');
      assert.equal((await s.post('bob', 'layers/change/cancel', { multisig: s.keys.multisig, changeId: queued.change.id }).expect(403)).body.code, 'denied');
    } finally { s.cleanup(); }
  });

  it('needs the passkey to tighten, never turns Biometrics off and never waives Limits', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      await s.enrollPasskey();
      const begin = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'wifi.add-network', label: 'Home' } }).expect(200)).body;
      assert.equal(begin.class, 'tighten'); assert.deepEqual(begin.required, [{ id: 'biometrics', evidence: 'passkey' }]);
      const missing = await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: begin.challengeId }).expect(403);
      assert.deepEqual(missing.body.layers.map((item: { id: string; ok: boolean }) => [item.id, item.ok]), [['biometrics', false]]);
      const credential = s.store.layerConfig(s.keys.multisig)!.biometrics!.credentials[0].id;
      assert.equal((await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'biometrics' } }).expect(403)).body.code, 'denied');
      assert.match((await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'passkey.remove', credentialId: credential } }).expect(403)).body.error, /required for every vault release/);
      assert.match((await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'wifi' }, waive: ['limits'] }).expect(400)).body.error, /Limits needs no recovery/);
      // MFA (the vault authenticator) is waivable like any optional layer: this refusal is about the change, never "never be waived".
      const mfaWaive = await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'wifi' }, waive: ['mfa'] });
      assert.ok(mfaWaive.status === 400 || mfaWaive.status === 409); assert.doesNotMatch(mfaWaive.body.error, /never be waived/);
      // Recovery: a lost passkey can be replaced without it, after 7 days.
      const recovery = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'New laptop' }, waive: ['biometrics'] }).expect(200)).body;
      assert.equal(recovery.class, 'recovery'); assert.equal(recovery.effectiveAt, new Date(s.now() + 7 * 24 * 60 * 60 * 1000).toISOString()); assert.equal(recovery.webauthn.get, null);
      const replacement = s.authenticator.register({ challenge: recovery.webauthn.create.challenge });
      const pending = (await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: recovery.challengeId, registration: replacement.response }).expect(200)).body;
      assert.equal(pending.change.class, 'recovery');
      assert.deepEqual((await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body.pending[0].waived, ['biometrics']);
      // Unknown ops, other accounts and malformed bodies are refused before anything is issued.
      await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'voice.add' } }).expect(400);
      await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'x' } }).expect(400);
      assert.equal((await s.post('bob', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'x' } }).expect(403)).body.code, 'denied');
      assert.equal((await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('bob')).expect(403)).body.code, 'denied');
      await request(s.app).get('/vault/solana/layers').query({ multisig: 'not-a-vault' }).set(s.as('alice')).expect(400);
    } finally { s.cleanup(); }
  });

  it('requires the Wi-Fi name and access point from ANTARA Desktop in network+radio mode', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const desktop = createTestAuthenticator({ rpId: 'localhost', origin: 'https://tauri.localhost' });
      const first = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Windows Hello' } }).expect(200)).body;
      const { passkey, response } = desktop.register({ challenge: first.webauthn.create.challenge });
      await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: first.challengeId, registration: response }).expect(200);
      const pc = createTestDevice('desktop');
      const HOME_WIFI = { ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' };
      const step = async (route: 'enroll' | 'change', op: Record<string, unknown>, device?: (begin: { purpose: string; challengeId: string; nonce: string; digest: string }) => Record<string, unknown>) => {
        const begin = (await s.post('alice', `layers/${route}/begin`, { multisig: s.keys.multisig, op }).expect(200)).body;
        const finish = await s.post('alice', `layers/${route}/finish`, {
          multisig: s.keys.multisig, challengeId: begin.challengeId, passkey: desktop.assert(passkey, { challenge: begin.webauthn.get.challenge }),
          ...(device ? { device: pc.evidence(devicePayload(s, begin, pc, device(begin))) } : {}),
        });
        return { begin, finish };
      };
      const wifiReading = (connections: Array<{ ssidHex: string; bssid: string }>) => () => ({ wifi: { connections, at: s.now(), source: 'windows-wlan' } });
      assert.equal((await step('enroll', { type: 'device.add', label: 'PC', surface: 'desktop', publicKeySpki: pc.publicKeySpki }, () => ({}))).finish.status, 200);
      assert.equal((await step('enroll', { type: 'wifi.add-network', label: 'Home' })).finish.status, 200);
      const radio = await step('enroll', { type: 'wifi.add-radio', label: 'Home Wi-Fi' }, wifiReading([HOME_WIFI]));
      assert.equal(radio.begin.class, 'tighten'); assert.deepEqual(radio.begin.capture, { wifi: true }); assert.equal(radio.finish.status, 200);
      assert.equal((await step('change', { type: 'wifi.set-mode', mode: 'network+radio' })).finish.body.status, 'applied');
      const view = (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body;
      const wifi = view.layers.find((layer: { id: string }) => layer.id === 'wifi');
      assert.deepEqual(wifi.kinds, ['server-observed', 'device-reported']); assert.equal(wifi.mode, 'network+radio');
      assert.deepEqual(wifi.items.map((item: { type: string; detail: string }) => [item.type, item.detail]), [['network', 'IPv4 203.0.x.x/32'], ['radio', 'Wi-Fi name with 1 access point · ••:••:••:••:EE:FF']]);
      assert.equal(JSON.stringify(view).includes('486f6d65'), false); assert.equal(JSON.stringify(view).includes('AA:BB:CC:DD'), false);
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const approve = async (connections: Array<{ ssidHex: string; bssid: string }>) => {
        const begin = (await s.post('alice', 'layers/approval/begin', { multisig: s.keys.multisig, transactionIndex: '1' }).expect(200)).body;
        assert.deepEqual(begin.required[1], { id: 'wifi', evidence: 'device', reading: 'wifi', desktopOnly: true });
        return s.post('alice', 'approve', {
          multisig: s.keys.multisig, transactionIndex: '1',
          layers: { challengeId: begin.challengeId, passkey: desktop.assert(passkey, { challenge: begin.webauthn.challenge }), device: pc.evidence(devicePayload(s, begin, pc, wifiReading(connections)())) },
        });
      };
      const otherAccessPoint = await approve([{ ...HOME_WIFI, bssid: 'AA:BB:CC:DD:EE:01' }]);
      assert.equal(otherAccessPoint.status, 403); assert.match(otherAccessPoint.body.layers.find((item: { id: string }) => item.id === 'wifi').reason, /not connected to one of your trusted Wi-Fi networks/);
      assert.equal((await approve([HOME_WIFI])).body.status, 'approved');
      // A new access point of the trusted Wi-Fi name is a loosening: it is accepted for the radio check of its own change, and applies at once.
      const radioId = wifi.items[1].id;
      const bssid = await step('enroll', { type: 'wifi.add-bssid', radioId }, wifiReading([{ ...HOME_WIFI, bssid: 'AA:BB:CC:DD:EE:01' }]));
      assert.equal(bssid.begin.class, 'loosen'); assert.equal(bssid.begin.effectiveAt, null); assert.equal(bssid.finish.body.status, 'applied');
      assert.equal(s.store.layerConfig(s.keys.multisig)?.wifi?.radios[0].bssids.length, 2);
    } finally { s.cleanup(); }
  });

  it('vault MFA: enrolls ANTARA’s own authenticator, needs a single-use code for every release while on, seals the secret, and fails closed without the key', async () => {
    const s = solanaRoutes();
    const multisig = s.keys.multisig;
    // The per-account route limits count real time: step past their one-minute windows between phases.
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    const nextWindow = () => { offset += 61_000; };
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      const add = { multisig, op: { type: 'mfa.add', label: 'Phone app' } };
      // Without the sealing key nothing that needs the authenticator starts (503), and the error never carries a key.
      const key = s.totpEnv[TOTP_KEY_ENV]!;
      delete s.totpEnv[TOTP_KEY_ENV];
      const noKey = await s.post('alice', 'layers/enroll/begin', add).expect(503);
      assert.match(noKey.body.error, /ANTARA_VAULT_TOTP_KEY/); assert.equal(noKey.body.code, 'unavailable');
      s.totpEnv[TOTP_KEY_ENV] = 'too-short';
      assert.equal((await s.post('alice', 'layers/enroll/begin', add).expect(503)).body.code, 'unavailable');
      s.totpEnv[TOTP_KEY_ENV] = key;
      // Enroll: the server generates the secret; turning MFA on is a tightening that needs the passkey and a code from the new app.
      const enrollWith = async (code: (secret: string) => string | undefined) => {
        const begin = (await s.post('alice', 'layers/enroll/begin', add).expect(200)).body;
        assert.equal(begin.class, 'tighten'); assert.equal(begin.effectiveAt, null);
        assert.deepEqual(begin.required, [{ id: 'biometrics', evidence: 'passkey' }]);
        assert.match(begin.capture.totp.secret, /^[A-Z2-7]{32}$/);
        const value = code(begin.capture.totp.secret);
        const response = await s.post('alice', 'layers/enroll/finish', {
          multisig, challengeId: begin.challengeId, passkey: s.authenticator.assert(passkey, { challenge: begin.webauthn.get.challenge }), ...(value === undefined ? {} : { totp: { code: value } }),
        });
        return { begin, response, secret: begin.capture.totp.secret as string };
      };
      const missing = await enrollWith(() => undefined);
      assert.equal(missing.response.status, 403); assert.deepEqual(missing.response.body.layers, [{ id: 'mfa', ok: false, reason: 'Enter the 6-digit code from your vault authenticator app.' }]);
      const wrong = await enrollWith(secret => totpCode(secret, s.now() + 5 * 60_000));
      assert.equal(wrong.response.status, 403); assert.equal(wrong.response.body.layers[0].id, 'mfa');
      assert.equal(s.store.layerConfig(multisig)!.mfa, null, 'nothing was stored');
      const enrolled = await enrollWith(secret => totpCode(secret, s.now()));
      assert.equal(enrolled.response.status, 200); assert.equal(enrolled.response.body.status, 'applied');
      const secret = enrolled.secret;
      // Encrypted at rest: the store holds only the sealed secret, bound to this vault.
      const stored = s.store.layerConfig(multisig)!.mfa!;
      const file = readFileSync(s.file, 'utf8');
      const raw = Buffer.from(base32Decode(secret)!);
      for (const form of [secret, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')]) assert.equal(file.includes(form), false, 'secret in the clear');
      assert.deepEqual(Buffer.from(openTotpSecret(stored.secret, totpKeyFromEnv(s.totpEnv), multisig)), raw);
      assert.throws(() => openTotpSecret(stored.secret, totpKeyFromEnv(s.totpEnv), s.carol.multisig));
      assert.throws(() => openTotpSecret(stored.secret, new Uint8Array(32).fill(9), multisig));
      // GET /solana/layers: on, enforced, Cryptographic, one authenticator item, never the secret.
      const view = (await request(s.app).get('/vault/solana/layers').query({ multisig }).set(s.as('alice')).expect(200)).body;
      const mfa = view.layers.find((layer: { id: string }) => layer.id === 'mfa');
      assert.equal(mfa.status, 'enrolled'); assert.equal(mfa.enforced, true); assert.deepEqual(mfa.kinds, ['cryptographic']);
      assert.deepEqual(mfa.items.map((item: { type: string; label: string; state: string }) => [item.type, item.label, item.state]), [['authenticator', 'Phone app', 'active']]);
      assert.equal(JSON.stringify(view).includes(secret), false);
      assert.equal((await s.post('alice', 'layers/enroll/begin', add).expect(409)).body.code, 'conflict');
      // Every release now needs a code, part of the evidence for this exact challenge.
      nextWindow();
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      const body = { multisig, transactionIndex: '1' };
      const attempt = async (code: string | undefined) => {
        const { begin, layers } = await s.evidence('alice', '1', passkey);
        assert.deepEqual(begin.required, [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'totp' }]);
        return s.post('alice', 'approve', { ...body, layers: { ...layers, ...(code === undefined ? {} : { totp: { code } }) } });
      };
      const noCode = await attempt(undefined);
      assert.equal(noCode.status, 403); assert.deepEqual(noCode.body.layers.find((item: { id: string }) => item.id === 'mfa'), { id: 'mfa', ok: false, reason: 'Enter the 6-digit code from your vault authenticator app.' });
      // Outside the one-step window either side.
      const stale = await attempt(totpCode(secret, s.now() - 2 * 30_000));
      assert.equal(stale.status, 403); assert.equal(stale.body.layers.find((item: { id: string }) => item.id === 'mfa').ok, false);
      // The enrollment code's step is already used: replay refused.
      const replayed = await attempt(totpCode(secret, s.now()));
      assert.equal(replayed.status, 403); assert.equal(replayed.body.layers.find((item: { id: string }) => item.id === 'mfa').ok, false);
      assert.equal(s.sends.length, 0, 'nothing was signed');
      // Four failures so far; a fresh lockout window, then the next step's code (one step ahead is inside the window) passes.
      s.advance(16 * 60_000);
      nextWindow();
      s.setProposal(1n, 300_000_000n, [s.keys.user]);
      const ahead = totpCode(secret, s.now() + 30_000);
      const approved = await attempt(ahead);
      assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.status, 'approved'); assert.equal(s.sends.length, 1);
      assert.deepEqual(s.store.ledgerEntry(multisig, '1')?.layers?.enforced, ['biometrics', 'mfa']);
      // The same code (and so the same step) is single use, even for another release.
      s.setProposal(2n, 100_000_000n, [s.keys.user]);
      const again = await s.evidence('alice', '2', passkey);
      const reused = await s.post('alice', 'approve', { multisig, transactionIndex: '2', layers: { ...again.layers, totp: { code: ahead } } }).expect(403);
      assert.equal(reused.body.layers.find((item: { id: string }) => item.id === 'mfa').ok, false); assert.equal(s.sends.length, 1);
      assert.equal((await s.post('alice', 'approve', { multisig, transactionIndex: '2', layers: { ...again.layers, totp: { code: '12345' } } }).expect(400)).body.code, 'invalid');
      // A lost authenticator app is a 7-day recovery that waives MFA (the lost-device path); MFA is not special-cased.
      s.advance(16 * 60_000);
      nextWindow();
      const recovery = (await s.post('alice', 'layers/change/begin', { multisig, op: { type: 'layer.disable', layer: 'mfa' }, waive: ['mfa'] }).expect(200)).body;
      assert.equal(recovery.class, 'recovery'); assert.equal(recovery.effectiveAt, new Date(s.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
      assert.deepEqual(recovery.required, [{ id: 'biometrics', evidence: 'passkey' }]);
      // Limits needs no recovery, so it is never in a waiver.
      assert.equal((await s.post('alice', 'layers/change/begin', { multisig, op: { type: 'layer.disable', layer: 'mfa' }, waive: ['limits'] }).expect(400)).body.code, 'invalid');
      // With MFA on, a missing key at release fails closed (503), never "MFA off".
      s.setProposal(3n, 100_000_000n, [s.keys.user]);
      const sealingKey = s.totpEnv[TOTP_KEY_ENV];
      delete s.totpEnv[TOTP_KEY_ENV];
      assert.equal((await s.post('alice', 'layers/approval/begin', { multisig, transactionIndex: '3' }).expect(503)).body.code, 'unavailable');
      assert.equal(s.sends.length, 1);
      s.totpEnv[TOTP_KEY_ENV] = sealingKey;
      // Turning MFA off is a loosening: it needs every layer that is on (a code too) and applies at once (no 24-hour wait).
      nextWindow();
      const off = (await s.post('alice', 'layers/change/begin', { multisig, op: { type: 'layer.disable', layer: 'mfa' } }).expect(200)).body;
      assert.equal(off.class, 'loosen'); assert.equal(off.effectiveAt, null);
      assert.deepEqual(off.required, [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'totp' }]);
      const applied = (await s.post('alice', 'layers/change/finish', {
        multisig, challengeId: off.challengeId, passkey: s.authenticator.assert(passkey, { challenge: off.webauthn.get.challenge }), totp: { code: totpCode(secret, s.now()) },
      }).expect(200)).body;
      assert.equal(applied.status, 'applied');
      const mfaView = (await request(s.app).get('/vault/solana/layers').query({ multisig }).set(s.as('alice')).expect(200)).body.layers.find((layer: { id: string }) => layer.id === 'mfa');
      assert.deepEqual([mfaView.status, mfaView.enforced], ['not-enrolled', false]);
    } finally { Date.now = realNow; s.cleanup(); }
  });

  it('applies a first passkey at once only from the registering session within 15 minutes, and allows nothing else before it', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const passkeyAdd = { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Laptop' } };
      // A second session of the same account (a stolen token, or another app) cannot claim the vault's first passkey.
      const stolen = await s.post('alice', 'layers/enroll/begin', passkeyAdd, { 'X-Test-Session': 'session-b' }).expect(403);
      assert.equal(stolen.body.code, 'denied'); assert.match(stolen.body.error, /app that activated it/);
      // Nothing else can be pre-positioned before the passkey, from any session.
      const device = createTestDevice('web');
      for (const session of ['session-a', 'session-b']) {
        for (const op of [{ type: 'device.add', label: 'Browser', surface: 'web', publicKeySpki: device.publicKeySpki }, { type: 'wifi.add-network', label: 'Home' }, { type: 'bluetooth.add-device', label: 'Phone' }]) {
          assert.match((await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op }, { 'X-Test-Session': session }).expect(409)).body.error, /Add a passkey to this vault first/);
        }
      }
      // An immediate first passkey begun in the window cannot finish after it closes.
      s.advance(14 * 60 * 1000);
      const late = (await s.post('alice', 'layers/enroll/begin', passkeyAdd).expect(200)).body;
      assert.equal(late.class, 'tighten'); assert.equal(late.effectiveAt, null);
      s.advance(60 * 1000);
      const closed = await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: late.challengeId, registration: s.authenticator.register({ challenge: late.webauthn.create.challenge }).response }).expect(409);
      assert.equal(closed.body.code, 'challenge-stale');
      assert.equal(s.store.layerConfig(s.keys.multisig), null);
      // After the window, even the registering session's first passkey is a 7-day recovery change, visible and cancelable, and registering again reopens nothing.
      assert.equal((await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200)).body.status, 'already-registered');
      const recovery = (await s.post('alice', 'layers/enroll/begin', passkeyAdd).expect(200)).body;
      assert.equal(recovery.class, 'recovery'); assert.equal(recovery.effectiveAt, new Date(s.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
      assert.equal(recovery.webauthn.get, null); assert.deepEqual(recovery.required, []);
      const queued = s.authenticator.register({ challenge: recovery.webauthn.create.challenge, counter: 1 });
      const pending = (await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: recovery.challengeId, registration: queued.response }).expect(200)).body;
      assert.equal(pending.status, 'pending'); assert.equal(pending.change.class, 'recovery');
      const view = (await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).expect(200)).body;
      const biometrics = view.layers.find((layer: { id: string }) => layer.id === 'biometrics');
      assert.equal(biometrics.status, 'not-enrolled'); assert.equal(biometrics.enforced, true);
      assert.deepEqual(biometrics.items.map((item: { state: string; detail: string }) => [item.state, item.detail]), [['pending-addition', 'Device-bound passkey · added from Web · added through recovery']]);
      assert.deepEqual(view.pending.map((item: { class: string; waived: string[] }) => [item.class, item.waived]), [['recovery', ['biometrics']]]);
      // Releases stay paused until it takes effect.
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      assert.match((await s.post('alice', 'layers/approval/begin', { multisig: s.keys.multisig, transactionIndex: '1' }).expect(403)).body.error, /Add a passkey/);
      s.advance(7 * 24 * 60 * 60 * 1000);
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const { layers } = await s.evidence('alice', '1', queued.passkey);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '1', layers }).expect(200)).body.status, 'approved');
      assert.equal(s.store.layerConfig(s.keys.multisig)?.biometrics?.credentials[0].addedVia, 'recovery');
    } finally { s.cleanup(); }
  });

  it('opens the first-passkey window only for the registering session, and uses it once', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).set('X-Test-Session', 'desktop-session').send({ multisig: s.keys.multisig }).expect(200);
      const begin = (session: string) => s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Laptop' } }, { 'X-Test-Session': session });
      assert.equal((await begin('session-a').expect(403)).body.code, 'denied');
      const first = (await begin('desktop-session').expect(200)).body;
      assert.equal(first.class, 'tighten');
      // The window belongs to that session: another session's finish of this challenge is refused too.
      const registration = s.authenticator.register({ challenge: first.webauthn.create.challenge, counter: 1 });
      assert.equal((await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: first.challengeId, registration: registration.response }, { 'X-Test-Session': 'session-a' }).expect(403)).body.code, 'challenge-invalid');
      const again = (await begin('desktop-session').expect(200)).body;
      const applied = await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: again.challengeId, registration: s.authenticator.register({ challenge: again.webauthn.create.challenge, counter: 1 }).response }, { 'X-Test-Session': 'desktop-session' }).expect(200);
      assert.deepEqual(applied.body, { status: 'applied', configVersion: 1 });
      assert.equal(s.store.layerConfig(s.keys.multisig)?.biometrics?.credentials[0].addedVia, undefined, 'an activation passkey is the owner’s original');
      // Once the vault has a passkey, another one is a loosening from any session.
      assert.equal((await begin('desktop-session').expect(200)).body.class, 'loosen');
    } finally { s.cleanup(); }
  });

  it('refuses every challenge route when authentication recorded no Privy session, instead of matching all sessions', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      const { begin, layers } = await s.evidence('alice', '1', passkey);
      const none = { 'X-Test-Session': 'none' };
      for (const [path, payload] of [
        ['layers/approval/begin', body], ['approve', { ...body, layers }], ['approve', body],
        ['layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'wifi.add-network', label: 'Home' } }],
        ['layers/enroll/finish', { multisig: s.keys.multisig, challengeId: begin.challengeId }],
        ['layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'wifi' } }],
      ] as const) {
        const refused = await s.post('alice', path, payload, none).expect(503);
        assert.equal(refused.body.code, 'unavailable', path); assert.match(refused.body.error, /sign-in session/);
      }
      assert.equal(s.sends.length, 0); assert.equal(s.store.ledger().length, 0);
      // The challenge was not consumed: with the session it was issued to, it still approves.
      assert.equal((await s.post('alice', 'approve', { ...body, layers }).expect(200)).body.status, 'approved');
      // Reading the status and cancelling a pending change need no challenge.
      await request(s.app).get('/vault/solana/layers').query({ multisig: s.keys.multisig }).set(s.as('alice')).set(none).expect(200);
      assert.equal((await s.post('alice', 'layers/change/cancel', { multisig: s.keys.multisig, changeId: 'chg_AAAAAAAAAAAAAAAA' }, none).expect(409)).body.code, 'conflict');
    } finally { s.cleanup(); }
  });

  it('never lets a direct caller of the guardian reserve or sign without the layer step', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const refused = (error: unknown) => error instanceof GuardianError && error.status === 409 && /not passed the vault's protection layers/.test(error.message);
      await assert.rejects(s.guardian.approve('did:privy:alice', { multisig: s.keys.multisig, transactionIndex: '1' }), refused);
      assert.equal(s.store.ledger().length, 0); assert.equal(s.sends.length, 0);
      // The route's layer step grants exactly one reservation, which carries the layers that passed.
      const { layers } = await s.evidence('alice', '1', passkey);
      assert.equal((await s.post('alice', 'approve', { multisig: s.keys.multisig, transactionIndex: '1', layers }).expect(200)).body.status, 'approved');
      assert.deepEqual(s.store.ledgerEntry(s.keys.multisig, '1')?.layers?.enforced, ['biometrics']);
      // A vote that did not land, retried directly after the pending window, is refused as well.
      s.advance(2 * 60 * 1000);
      await assert.rejects(s.guardian.approve('did:privy:alice', { multisig: s.keys.multisig, transactionIndex: '1' }), refused);
      assert.equal(s.sends.length, 1);
    } finally { s.cleanup(); }
  });

  it('returns Desktop Bluetooth devices only as opaque, challenge-bound ids, never their hardware address', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const desktop = createTestAuthenticator({ rpId: 'localhost', origin: 'https://tauri.localhost' });
      const first = (await s.post('alice', 'layers/enroll/begin', { multisig: s.keys.multisig, op: { type: 'passkey.add', label: 'Windows Hello' } }).expect(200)).body;
      const { passkey, response } = desktop.register({ challenge: first.webauthn.create.challenge });
      await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: first.challengeId, registration: response }).expect(200);
      const pc = createTestDevice('desktop');
      const MAC = '001A7DDA7113';
      const step = async (route: 'enroll' | 'change', op: Record<string, unknown>, reading?: Record<string, unknown>) => {
        const begin = (await s.post('alice', `layers/${route}/begin`, { multisig: s.keys.multisig, op }).expect(200)).body;
        const finish = await s.post('alice', `layers/${route}/finish`, {
          multisig: s.keys.multisig, challengeId: begin.challengeId, passkey: desktop.assert(passkey, { challenge: begin.webauthn.get.challenge }),
          ...(reading ? { device: pc.evidence(devicePayload(s, begin, pc, reading)) } : {}),
        });
        return { begin, finish };
      };
      assert.equal((await step('enroll', { type: 'device.add', label: 'PC', surface: 'desktop', publicKeySpki: pc.publicKeySpki }, {})).finish.status, 200);
      assert.equal((await step('enroll', { type: 'bluetooth.add-device', label: 'Phone' }, { bluetooth: { devices: [{ identifier: MAC, name: 'Bastian Pixel' }], at: s.now(), source: 'windows-classic' } })).finish.status, 200);
      const nonceOf = (begin: { nonce: string }) => new Uint8Array(Buffer.from(begin.nonce, 'base64url'));
      // Any session holder can start a change that needs Bluetooth: the answer carries an opaque id bound to that challenge, with no name.
      const disable = (await s.post('alice', 'layers/change/begin', { multisig: s.keys.multisig, op: { type: 'layer.disable', layer: 'bluetooth' } }).expect(200)).body;
      assert.deepEqual(disable.required.find((item: { id: string }) => item.id === 'bluetooth').match, [{ surface: 'desktop', source: 'windows-classic', identifier: bluetoothMatchId(nonceOf(disable), MAC), name: '' }]);
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      const required = await s.post('alice', 'approve', body).expect(403);
      assert.deepEqual(required.body.required.find((item: { id: string }) => item.id === 'bluetooth').match, [], 'no challenge, so no Desktop entry');
      const begin = (await s.post('alice', 'layers/approval/begin', body).expect(200)).body;
      const match = begin.required.find((item: { id: string }) => item.id === 'bluetooth').match;
      assert.equal(match[0].identifier, bluetoothMatchId(nonceOf(begin), MAC)); assert.notEqual(match[0].identifier, disable.required.find((item: { id: string }) => item.id === 'bluetooth').match[0].identifier);
      for (const text of [JSON.stringify(disable), JSON.stringify(required.body), JSON.stringify(begin)]) { assert.equal(text.includes(MAC), false); assert.equal(text.includes('Bastian'), false); }
      // Desktop compares its connected devices with the same function and signs the raw address of the one that matches.
      const approved = await s.post('alice', 'approve', {
        ...body, layers: { challengeId: begin.challengeId, passkey: desktop.assert(passkey, { challenge: begin.webauthn.challenge }), device: pc.evidence(devicePayload(s, begin, pc, { bluetooth: { devices: [{ identifier: MAC, name: '' }], at: s.now(), source: 'windows-classic' } })) },
      }).expect(200);
      assert.equal(approved.body.status, 'approved');
    } finally { s.cleanup(); }
  });

  it('refuses oversized evidence and passes through only the defined refusal shapes', async () => {
    const s = solanaRoutes();
    try {
      await request(s.app).post('/vault/solana/register').set(s.as('alice')).send({ multisig: s.keys.multisig }).expect(200);
      const { passkey } = await s.enrollPasskey();
      s.setProposal(1n, 100_000_000n, [s.keys.user]);
      const body = { multisig: s.keys.multisig, transactionIndex: '1' };
      const { layers } = await s.evidence('alice', '1', passkey);
      const huge = { ...layers, passkey: { ...layers.passkey, clientExtensionResults: { padding: 'x'.repeat(17_000) } } };
      assert.deepEqual((await s.post('alice', 'approve', { ...body, layers: huge }).expect(400)).body, { error: 'The verification evidence is too large.', code: 'invalid' });
      const finish = await s.post('alice', 'layers/enroll/finish', { multisig: s.keys.multisig, challengeId: layers.challengeId, registration: { padding: 'x'.repeat(17_000) } }).expect(400);
      assert.equal(finish.body.error, 'The verification evidence is too large.');
      await s.post('alice', 'approve', { ...body, layers: { challengeId: layers.challengeId, voice: 'hello' } }).expect(400);
      await s.post('alice', 'approve', { ...body, extra: true }).expect(400);
      // The oversized request consumed nothing: the challenge is still usable.
      const approved = await s.post('alice', 'approve', { ...body, layers }).expect(200);
      assert.deepEqual(Object.keys(approved.body).sort(), ['amountRaw', 'asset', 'recipient', 'signature', 'status']);
      s.setProposal(2n, 100_000_000n, [s.keys.user]);
      assert.deepEqual(Object.keys((await s.post('alice', 'approve', { ...body, transactionIndex: '2' }).expect(403)).body).sort(), ['code', 'error', 'required']);
      const failed = await s.post('alice', 'approve', { ...body, transactionIndex: '2', layers: (await s.evidence('alice', '2', passkey, { uv: false })).layers }).expect(403);
      assert.deepEqual(Object.keys(failed.body).sort(), ['code', 'error', 'layers']);
      assert.deepEqual(Object.keys(failed.body.layers[0]).sort(), ['id', 'ok', 'reason']);
    } finally { s.cleanup(); }
  });
});
