import { SOLANA_GENESIS } from '../../../../src/solares/wallet/solanaNetwork';
/**
 * TEST ONLY. Never imported by application code.
 *
 * The real paired-vault routes, guardian service, layer service, policy and file
 * store on an ephemeral 127.0.0.1 port, with Privy, the Solana RPC and the clock
 * faked. The client end-to-end test (src/solares/layers/endToEnd.test.ts) drives
 * the shipped client flow code against it over HTTP.
 *
 * - Requests authenticate as `Bearer did:privy:<name>`; the Privy session id is
 *   `session-a` unless the `X-Test-Session` header names another (what
 *   requirePrivyUser records from verifyAccessToken().session_id).
 * - Express trusts one proxy hop, so `X-Forwarded-For` sets the observed public IP.
 * - Passkeys use the development RP ID (`localhost`); the allowed origins are the
 *   development ones (layers/config.ts), so `https://tauri.localhost` is Desktop.
 * - Every guardian vote is a Privy `signAndSendTransaction` call recorded in `sends`.
 * - The per-account rate limits count real time (Date.now); `nextRateWindow` moves Date.now one window
 *   forward, so a long scripted session is not rate limited. close() restores Date.now.
 */
import express, { type RequestHandler } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';
import { pairedVaultAddresses, type RawSolanaAccount } from '../../../../src/solares/paired/solanaDecode';
import { multisigAccount, pairedKeys, proposalAccount, recentBlockhash, vaultTransactionAccount } from '../../../../src/solares/paired/testFixtures';
import { GUARDIAN_ENV, createGuardianSigner, createPairedVaultGuardian, readGuardianConfig, type GuardianPrivyClient, type GuardianSendInput, type SolanaRpc } from '../guardian.js';
import { pairedVaultRouter } from '../pairedVault.js';
import type { LinkedSolanaWallet, PrivyUserFacts } from '../vaultPolicy.js';
import { VAULT_STORE_FILE, createVaultStore } from '../vaultStore.js';
import type { SolaresUser } from '../wallet.js';
import { layerServerConfig } from './config.js';
import { createVaultLayerService, type LayerAuditEvent } from './service.js';

export interface LayerTestServer {
  /** Origin of the running API (`http://127.0.0.1:<port>`); routes are under /api/solares/paired-vault. */
  origin: string;
  keys: ReturnType<typeof pairedKeys>;
  users: Record<string, PrivyUserFacts>;
  /** Every guardian vote sent through Privy. */
  sends: GuardianSendInput[];
  audits: LayerAuditEvent[];
  /** Puts a SOL release proposal `index` of `lamports` to the user's own wallet on the fake chain. */
  setProposal(index: bigint, lamports: bigint): void;
  now(): number;
  advance(ms: number): void;
  /** Moves Date.now past the one-minute rate-limit windows (the service clock is unaffected). */
  nextRateWindow(): void;
  close(): Promise<void>;
}

export async function startLayerTestServer(start = Date.parse('2026-10-13T09:00:00.000Z')): Promise<LayerTestServer> {
  const keys = pairedKeys();
  const dir = mkdtempSync(join(tmpdir(), 'antara-layers-e2e-'));
  const chain = new Map<string, RawSolanaAccount | null>([[keys.multisig, multisigAccount(keys, { transactionIndex: 3n })]]);
  const rpc: SolanaRpc = {
    genesisHash: async () => SOLANA_GENESIS['mainnet-beta'],
    accounts: async list => list.map(address => chain.get(address) ?? null),
    countSpendingLimits: async () => 0,
    latestBlockhash: async () => recentBlockhash(),
    // A well-funded vault deposit address and the live rent-exempt minimum (vaultPolicy.ts checks both for SOL releases).
    balance: async () => 10_000_000_000_000n,
    rentExemptMinimum: async () => 650_240n,
  };
  const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const env = {
    [GUARDIAN_ENV.authorizationKey]: p256().privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    [GUARDIAN_ENV.walletId]: 'walletid0000000000000001', [GUARDIAN_ENV.address]: keys.guardian, [GUARDIAN_ENV.policyId]: 'policyid0000000000000001',
    [GUARDIAN_ENV.signerId]: 'quorumsigner000000000001', [GUARDIAN_ENV.ownerQuorumId]: 'quorumowner0000000000001',
  };
  const config = readGuardianConfig(env);
  const admin = p256().publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sends: GuardianSendInput[] = [];
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
      sends.push(input);
      return { hash: `${'5'.repeat(87)}${'123456789'[sends.length % 9]}` };
    },
  };
  let clock = start;
  const linked = (address: string): LinkedSolanaWallet => ({ address, embedded: true, delegated: false, imported: false, userCanSign: true });
  const users: Record<string, PrivyUserFacts> = { 'did:privy:alice': { id: 'did:privy:alice', solanaWallets: [linked(keys.user)] } };
  const loadUser = async (id: string) => { const user = users[id]; if (!user) throw new Error('unknown user'); return user; };
  // As the server opens it: every reservation needs the layer step's release authorization.
  const store = createVaultStore(join(dir, VAULT_STORE_FILE), { requireReleaseAuthorization: true });
  const guardian = createPairedVaultGuardian({
    guardian: createGuardianSigner({ config, client: privy, latestBlockhash: rpc.latestBlockhash }),
    rpc, cluster: 'mainnet-beta', store, now: () => clock, loadUser, audit: () => {},
  });
  const audits: LayerAuditEvent[] = [];
  const layers = createVaultLayerService({
    store, rpc, cluster: 'mainnet-beta', guardian: keys.guardian, now: () => clock, loadUser,
    passkeyConfig: () => layerServerConfig({}), network: { production: false, trustProxy: 1 }, audit: event => { audits.push(event); },
  });
  const authenticate: RequestHandler = (req, res, next) => {
    const match = /^Bearer (did:privy:[a-z]+)$/.exec(req.headers.authorization || '');
    if (!match) { res.status(401).json({ error: 'A valid Privy session is required.' }); return; }
    const session = req.headers['x-test-session'] ?? 'session-a';
    req.solaresUser = { id: match[1], wallets: [], ...(typeof session === 'string' && session !== 'none' ? { sessionId: session } : {}) } as SolaresUser;
    next();
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/solares/paired-vault', pairedVaultRouter({
    authenticate, configured: () => false, cosigner: (): Address => '0x2222222222222222222222222222222222222222',
    predict: async (): Promise<Address> => { throw new Error('EVM discovery is not under test'); }, deployed: async () => false,
    solanaGuardian: () => guardian, solanaLayers: () => layers,
  }));
  const realDateNow = Date.now;
  let rateOffset = 0;
  Date.now = () => realDateNow() + rateOffset;
  const server = await new Promise<import('node:http').Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`, keys, users, sends, audits,
    setProposal(index, lamports) {
      const addresses = pairedVaultAddresses(keys.multisig, index);
      chain.set(keys.multisig, multisigAccount(keys, { transactionIndex: index > 3n ? index : 3n }));
      chain.set(addresses.proposal!, proposalAccount(keys, { index, approved: [keys.user], status: 'Active' }));
      chain.set(addresses.transaction!, vaultTransactionAccount(keys, { index, instructions: [{ kind: 'sol', to: keys.user, lamports }] }));
    },
    now: () => clock,
    advance: ms => { clock += ms; },
    nextRateWindow: () => { rateOffset += 61_000; },
    close: () => new Promise<void>(resolve => server.close(() => { Date.now = realDateNow; rmSync(dir, { recursive: true, force: true }); resolve(); })),
  };
}
