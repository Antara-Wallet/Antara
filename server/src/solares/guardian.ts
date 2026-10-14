/**
 * ANTARA guardian (G) for paired Solana vaults.
 *
 * G is a Privy server wallet whose owner is a 2-of-2 key quorum {ANTARA server
 * key, owner's offline admin key}. Day to day the server signs through an
 * additional 1-of-1 signer quorum bound to a deny-by-default Privy policy that
 * only allows Squads proposal_approve (see docs/GUARDIAN.md and
 * scripts/provision-guardian.mjs).
 *
 * This module never accepts a client-built transaction. It builds the single
 * transaction G ever signs (one proposal_approve by G for one multisig and
 * index, G paying the fee), re-verifies those bytes, and only then asks Privy to
 * sign and send. Any missing configuration, RPC failure or mismatch fails
 * closed. It also owns the guardian's on-chain reads and the register/approve
 * service that the paired-vault routes call.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { PrivyClient } from '@privy-io/node';
import bs58 from 'bs58';
import { SOLANA_GENESIS } from '../../../src/solares/wallet/solanaNetwork';
import {
  PAIRED_POLICY_VERSION, PairedVaultDecodeError, SOLANA_GENESIS_HASH, SQUADS_PROGRAM_ID, assertGuardianApproveTransaction, buildGuardianApproveTransaction,
  decodePairedMultisig, isSolanaAddress, isSolanaWalletAddress, pairedVaultAddresses, parseTransactionIndex, releaseTokenDestination, spendingLimitFilters,
  type RawSolanaAccount,
} from '../../../src/solares/paired/solanaDecode';
import {
  NO_RELEASE_LIMITS, approvalsInWindow, evaluateRegistration, evaluateRelease, pairedWalletProblem, privyUserFacts,
  type OnchainSnapshot, type PrivyUserFacts,
} from './vaultPolicy.js';
import {
  VaultStoreError, createVaultStore, vaultStoreOptions, vaultStorePath, type LedgerEntry, type PairedVaultRecord, type VaultStore,
} from './vaultStore.js';

export type SolanaClusterName = keyof typeof SOLANA_GENESIS_HASH;
export const SOLANA_CAIP2: Readonly<Record<SolanaClusterName, string>> = Object.freeze({
  'mainnet-beta': `solana:${SOLANA_GENESIS_HASH['mainnet-beta']}`,
  devnet: `solana:${SOLANA_GENESIS_HASH.devnet}`,
});

/** Thrown for every refusal; `status` is the HTTP status a route should return. */
export class GuardianError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 | 429 | 503, readonly code: 'invalid' | 'denied' | 'conflict' | 'busy' | 'unavailable') {
    super(message); this.name = 'GuardianError';
  }
}
const unavailable = (message: string) => new GuardianError(message, 503, 'unavailable');

export interface GuardianConfig {
  walletId: string;
  address: string;
  /** Base64 PKCS#8 P-256 private key for the 1-of-1 signer quorum. Never logged or returned. */
  authorizationKey: string;
  /** Base64 SPKI DER public half of `authorizationKey` (not secret), used to check both key quorums. */
  serverPublicKey: string;
  policyId: string;
  signerId: string;
  /** The 2-of-2 {server, offline admin} key quorum that must own the guardian wallet. */
  ownerQuorumId: string;
  cluster: SolanaClusterName;
  caip2: string;
}
export const GUARDIAN_ENV = Object.freeze({
  authorizationKey: 'ANTARA_GUARDIAN_AUTH_KEY',
  walletId: 'ANTARA_GUARDIAN_SOLANA_WALLET_ID',
  address: 'ANTARA_GUARDIAN_SOLANA_ADDRESS',
  policyId: 'ANTARA_GUARDIAN_POLICY_ID',
  signerId: 'ANTARA_GUARDIAN_SIGNER_ID',
  ownerQuorumId: 'ANTARA_GUARDIAN_OWNER_QUORUM_ID',
});
const PRIVY_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Reads and validates guardian configuration without ever echoing a value. */
export function readGuardianConfig(env: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const value = (name: string) => env[name]?.trim() ?? '';
  const walletId = value(GUARDIAN_ENV.walletId), address = value(GUARDIAN_ENV.address);
  const policyId = value(GUARDIAN_ENV.policyId), signerId = value(GUARDIAN_ENV.signerId), ownerQuorumId = value(GUARDIAN_ENV.ownerQuorumId);
  const key = value(GUARDIAN_ENV.authorizationKey).replace(/^wallet-auth:/, '');
  const missing = Object.entries(GUARDIAN_ENV).filter(([, name]) => !value(name)).map(([, name]) => name);
  if (missing.length) throw unavailable(`The paired-vault guardian is not configured (missing ${missing.join(', ')}).`);
  if (![walletId, policyId, signerId, ownerQuorumId].every(id => PRIVY_ID.test(id))) throw unavailable('The guardian Privy identifiers are malformed.');
  if (signerId === ownerQuorumId) throw unavailable(`${GUARDIAN_ENV.signerId} and ${GUARDIAN_ENV.ownerQuorumId} must be different key quorums.`);
  if (!isSolanaWalletAddress(address)) throw unavailable(`${GUARDIAN_ENV.address} must be the guardian's Solana wallet address.`);
  let serverPublicKey: string;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error('format');
    const parsed = createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' });
    if (parsed.asymmetricKeyType !== 'ec' || parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve');
    serverPublicKey = createPublicKey(parsed).export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { throw unavailable(`${GUARDIAN_ENV.authorizationKey} must be a base64 PKCS#8 P-256 private key.`); }
  const cluster: SolanaClusterName = env.SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
  return { walletId, address, authorizationKey: key, serverPublicKey, policyId, signerId, ownerQuorumId, cluster, caip2: SOLANA_CAIP2[cluster] };
}
export function guardianConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try { readGuardianConfig(env); return true; } catch { return false; }
}

/** The Privy calls the guardian needs; injectable for tests. */
export interface GuardianWalletInfo {
  id: string; address: string; chain_type: string; owner_id: string | null; policy_ids: string[];
  additional_signers: Array<{ signer_id: string; override_policy_ids?: string[] }>;
  exported_at: number | null; imported_at: number | null; archived_at?: number | null;
}
export interface GuardianKeyQuorumInfo {
  id: string;
  authorization_keys: Array<{ public_key: string }>;
  authorization_threshold: number | null;
  user_ids: string[] | null;
  key_quorum_ids?: string[];
}
export interface GuardianSendInput { caip2: string; transaction: Uint8Array; authorizationKey: string; idempotencyKey: string }
export interface GuardianPrivyClient {
  getWallet(walletId: string): Promise<GuardianWalletInfo>;
  getKeyQuorum(keyQuorumId: string): Promise<GuardianKeyQuorumInfo>;
  signAndSendTransaction(walletId: string, input: GuardianSendInput): Promise<{ hash: string }>;
}
export function privyGuardianClient(privy: PrivyClient): GuardianPrivyClient {
  return {
    async getWallet(walletId) { return await privy.wallets().get(walletId); },
    async getKeyQuorum(keyQuorumId) { return await privy.keyQuorums().get(keyQuorumId); },
    async signAndSendTransaction(walletId, input) {
      return privy.wallets().solana().signAndSendTransaction(walletId, {
        caip2: input.caip2,
        transaction: input.transaction,
        authorization_context: { authorization_private_keys: [input.authorizationKey] },
        idempotency_key: input.idempotencyKey,
      });
    },
  };
}

export interface GuardianSigner {
  readonly address: string;
  /**
   * Proves, with Privy, that the configured wallet is the pinned guardian: right
   * address, never exported, owned by the pinned 2-of-2 quorum, bound to exactly
   * the pinned policy, with exactly the pinned 1-of-1 signer quorum holding only
   * the server key. Throws GuardianError(503) otherwise. A success is cached for
   * a short time; a failure never is.
   */
  verify(): Promise<void>;
  /** Votes G's approval for (multisig, index). Builds and verifies the transaction itself. */
  approve(request: { multisig: string; transactionIndex: string | bigint }): Promise<{ signature: string }>;
}
export interface GuardianSignerDependencies {
  config: GuardianConfig;
  client: GuardianPrivyClient;
  latestBlockhash: () => Promise<string>;
  /** Test seam only. Whatever it returns is still verified before signing. */
  buildTransaction?: typeof buildGuardianApproveTransaction;
  now?: () => number;
  /** How long a successful binding check is trusted before it is repeated. */
  bindingTtlMs?: number;
}
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const GUARDIAN_BINDING_TTL_MS = 10 * 60 * 1000;

/** Normalises a Privy authorization public key (base64 SPKI DER, possibly wrapped or PEM-armoured); null if unparseable. */
export function normaliseAuthorizationPublicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return key.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { return null; }
}
const exactly = (list: readonly unknown[] | null | undefined, expected: readonly string[]) =>
  Array.isArray(list) && list.length === expected.length && expected.every((item, index) => list[index] === item);
function quorumKeys(quorum: GuardianKeyQuorumInfo | null | undefined, id: string, threshold: number): string[] | null {
  if (!quorum || quorum.id !== id || quorum.authorization_threshold !== threshold) return null;
  if ((quorum.user_ids ?? []).length !== 0 || (quorum.key_quorum_ids ?? []).length !== 0) return null;
  const keys = (quorum.authorization_keys ?? []).map(item => normaliseAuthorizationPublicKey(item?.public_key));
  return keys.every((key): key is string => key !== null) && new Set(keys).size === keys.length ? keys : null;
}

export function createGuardianSigner(deps: GuardianSignerDependencies): GuardianSigner {
  const { config, client } = deps;
  const build = deps.buildTransaction ?? buildGuardianApproveTransaction;
  const now = deps.now ?? Date.now;
  const ttl = deps.bindingTtlMs ?? GUARDIAN_BINDING_TTL_MS;
  const checkBinding = async () => {
    let wallet: GuardianWalletInfo, signerQuorum: GuardianKeyQuorumInfo, ownerQuorum: GuardianKeyQuorumInfo;
    try {
      [wallet, signerQuorum, ownerQuorum] = await Promise.all([client.getWallet(config.walletId), client.getKeyQuorum(config.signerId), client.getKeyQuorum(config.ownerQuorumId)]);
    } catch { throw unavailable('The guardian wallet could not be verified with Privy.'); }
    if (!wallet || wallet.id !== config.walletId || wallet.chain_type !== 'solana' || wallet.address !== config.address) throw unavailable('The Privy guardian wallet does not match the pinned guardian address.');
    if (wallet.exported_at != null || wallet.imported_at != null || wallet.archived_at != null) throw unavailable('The guardian key was exported, imported or archived. Provision a new guardian.');
    if (wallet.owner_id !== config.ownerQuorumId) throw unavailable('The guardian wallet is not owned by the pinned admin key quorum.');
    const signers = wallet.additional_signers;
    if (!exactly(wallet.policy_ids, [config.policyId]) || !Array.isArray(signers) || signers.length !== 1 ||
      signers[0]?.signer_id !== config.signerId || !exactly(signers[0].override_policy_ids, [config.policyId])) {
      throw unavailable('The guardian wallet does not carry exactly its pinned signer and signing policy.');
    }
    // The 1-of-1 signer quorum can be edited with the server key alone, so its membership is re-checked.
    const signerKeys = quorumKeys(signerQuorum, config.signerId, 1);
    if (!signerKeys || !exactly(signerKeys, [config.serverPublicKey])) throw unavailable('The guardian signer key quorum has changed. Nothing was signed.');
    const ownerKeys = quorumKeys(ownerQuorum, config.ownerQuorumId, 2);
    if (!ownerKeys || ownerKeys.length !== 2 || !ownerKeys.includes(config.serverPublicKey)) throw unavailable('The guardian owner key quorum is not the provisioned 2-of-2. Nothing was signed.');
  };
  let binding: { checkedAt: number; promise: Promise<void> } | null = null;
  const verify = () => {
    const at = now();
    if (binding && at - binding.checkedAt >= 0 && at - binding.checkedAt < ttl) return binding.promise;
    const current = { checkedAt: at, promise: checkBinding() };
    binding = current;
    current.promise.catch(() => { if (binding === current) binding = null; });
    return current.promise;
  };

  return {
    address: config.address,
    verify,
    async approve(request) {
      if (!isSolanaAddress(request.multisig)) throw new GuardianError('Invalid vault address.', 400, 'invalid');
      let transactionIndex: bigint;
      try { transactionIndex = parseTransactionIndex(request.transactionIndex); } catch { throw new GuardianError('Invalid proposal index.', 400, 'invalid'); }
      await verify();
      let recentBlockhash: string;
      try { recentBlockhash = await deps.latestBlockhash(); } catch { throw unavailable('The Solana network could not be reached.'); }
      if (!isSolanaAddress(recentBlockhash)) throw unavailable('The Solana network returned an invalid blockhash.');
      const expected = { multisig: request.multisig, transactionIndex, guardian: config.address };
      const transaction = build({ ...expected, recentBlockhash });
      // Refuse to sign anything but the exact vote, even if the builder misbehaves.
      try { assertGuardianApproveTransaction(transaction, expected); } catch { throw new GuardianError('The guardian refused to sign an unexpected transaction.', 403, 'denied'); }
      const idempotencyKey = `antara-g-${createHash('sha256').update(`${request.multisig}:${transactionIndex}:${recentBlockhash}`).digest('hex').slice(0, 40)}`;
      let result: { hash: string };
      try { result = await client.signAndSendTransaction(config.walletId, { caip2: config.caip2, transaction, authorizationKey: config.authorizationKey, idempotencyKey }); }
      catch { throw unavailable('Privy did not sign the guardian approval.'); }
      if (!result || typeof result.hash !== 'string' || !SIGNATURE.test(result.hash)) throw unavailable('Privy returned an invalid transaction signature.');
      return { signature: result.hash };
    },
  };
}

/** Minimal Solana JSON-RPC reads the guardian needs (no client-side web3 objects cross into the server). */
export interface SolanaRpc {
  genesisHash(): Promise<string>;
  accounts(addresses: string[]): Promise<Array<RawSolanaAccount | null>>;
  countSpendingLimits(multisig: string): Promise<number>;
  latestBlockhash(): Promise<string>;
  /**
   * Squads multisig accounts with exactly the paired layout whose two members are `member` and `guardian`, in either
   * order (pairedMultisigDiscoveryFilters). Candidates only: every one is decoded and verified before it is reported.
   * Optional: without it, account() reports no on-chain discovery.
   */
  pairedMultisigs?(member: string, guardian: string): Promise<RawSolanaAccount[]>;
  /**
   * Lamports held by `address` (getBalance, confirmed). Read for a vault's deposit address before a SOL release vote.
   * Optional for test doubles only: without it a SOL release is refused (fail closed, vaultPolicy.ts).
   */
  balance?(address: string): Promise<bigint>;
  /**
   * Solana's live rent-exempt minimum for an account of `dataLength` bytes (getMinimumBalanceForRentExemption),
   * never a constant. Optional for test doubles only: without it a SOL release is refused (fail closed).
   */
  rentExemptMinimum?(dataLength: number): Promise<bigint>;
}
/**
 * A paired vault's Squads multisig account as multisigCreateV2 writes it for ANTARA (rent collector set to the user):
 * discriminator 8, create key 32, config authority 32, threshold 2, time lock 4, transaction indexes 8 + 8, rent
 * collector 1 + 32, bump 1, member count 4, then two members of 32 + 1 bytes. So it is 198 bytes long and the member
 * keys sit at offsets 132 and 165. Squads keeps members sorted by key, so U can be either one.
 */
export const PAIRED_MULTISIG_DATA_SIZE = 198;
export const PAIRED_MEMBER_OFFSETS = Object.freeze([132, 165] as const);
/** The Anchor discriminator of a Squads v4 Multisig account (sha256("account:Multisig"), first 8 bytes), base58. */
export const SQUADS_MULTISIG_DISCRIMINATOR = bs58.encode(createHash('sha256').update('account:Multisig').digest().subarray(0, 8));
/** getProgramAccounts filter sets (one per member order) for paired multisigs of exactly `member` and `guardian`. */
export function pairedMultisigDiscoveryFilters(member: string, guardian: string) {
  if (!isSolanaWalletAddress(member) || !isSolanaWalletAddress(guardian) || member === guardian) throw new Error('Paired vault discovery needs two different wallet addresses.');
  return [[member, guardian], [guardian, member]].map(([first, second]) => [
    { dataSize: PAIRED_MULTISIG_DATA_SIZE },
    { memcmp: { offset: 0, bytes: SQUADS_MULTISIG_DISCRIMINATOR } },
    { memcmp: { offset: PAIRED_MEMBER_OFFSETS[0], bytes: first } },
    { memcmp: { offset: PAIRED_MEMBER_OFFSETS[1], bytes: second } },
  ]);
}
const MAX_RPC_RESPONSE_BYTES = 2_000_000;
export function solanaJsonRpc(url: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SolanaRpc {
  const fetcher = options.fetch ?? fetch;
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok) throw new Error(`RPC ${method} failed`);
    const text = await response.text();
    if (text.length > MAX_RPC_RESPONSE_BYTES) throw new Error(`RPC ${method} response too large`);
    const body = JSON.parse(text) as { result?: T; error?: unknown };
    if (body.error !== undefined || body.result === undefined) throw new Error(`RPC ${method} returned an error`);
    return body.result;
  }
  const account = (value: unknown, address: string): RawSolanaAccount | null => {
    if (value === null) return null;
    const item = value as { owner?: unknown; data?: unknown };
    if (!item || typeof item.owner !== 'string' || !Array.isArray(item.data) || item.data[1] !== 'base64' || typeof item.data[0] !== 'string') throw new Error('RPC returned an unexpected account');
    return { address, owner: item.owner, data: new Uint8Array(Buffer.from(item.data[0], 'base64')) };
  };
  return {
    genesisHash: () => call<string>('getGenesisHash', []),
    async accounts(addresses) {
      const result = await call<{ value?: unknown[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
      if (!Array.isArray(result?.value) || result.value.length !== addresses.length) throw new Error('RPC returned an unexpected account list');
      return result.value.map((value, index) => account(value, addresses[index]));
    },
    async countSpendingLimits(multisig) {
      const result = await call<unknown[]>('getProgramAccounts', [SQUADS_PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, filters: spendingLimitFilters(multisig) }]);
      if (!Array.isArray(result)) throw new Error('RPC returned an unexpected program account list');
      return result.length;
    },
    async latestBlockhash() {
      const result = await call<{ value?: { blockhash?: unknown } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      if (typeof result?.value?.blockhash !== 'string') throw new Error('RPC returned an unexpected blockhash');
      return result.value.blockhash;
    },
    async balance(address) {
      if (!isSolanaAddress(address)) throw new Error('Invalid balance address');
      const result = await call<{ value?: unknown }>('getBalance', [address, { commitment: 'confirmed' }]);
      const value = result?.value;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('RPC returned an unexpected balance');
      return BigInt(value);
    },
    async rentExemptMinimum(dataLength) {
      if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataLength > 10_485_760) throw new Error('Invalid account size');
      const result = await call<unknown>('getMinimumBalanceForRentExemption', [dataLength, { commitment: 'confirmed' }]);
      if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error('RPC returned an unexpected minimum balance');
      return BigInt(result);
    },
    async pairedMultisigs(member, guardian) {
      const lists = await Promise.all(pairedMultisigDiscoveryFilters(member, guardian).map(filters =>
        call<unknown>('getProgramAccounts', [SQUADS_PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed', filters }])));
      const found = new Map<string, RawSolanaAccount>();
      for (const list of lists) {
        if (!Array.isArray(list)) throw new Error('RPC returned an unexpected program account list');
        for (const item of list as Array<{ pubkey?: unknown; account?: unknown } | null>) {
          if (!item || !isSolanaAddress(item.pubkey)) throw new Error('RPC returned an unexpected program account');
          const read = account(item.account ?? null, item.pubkey);
          if (read) found.set(item.pubkey, read);
        }
      }
      return [...found.values()];
    },
  };
}

const verifiedClusters = new WeakMap<SolanaRpc, string>();
async function assertCluster(rpc: SolanaRpc, cluster: SolanaClusterName) {
  if (verifiedClusters.get(rpc) === cluster) return;
  // getGenesisHash returns the full hash; SOLANA_GENESIS_HASH holds the 32-character CAIP-2 references.
  if (await rpc.genesisHash() !== SOLANA_GENESIS[cluster]) throw new Error('The Solana RPC serves a different cluster.');
  verifiedClusters.set(rpc, cluster);
}
/** Fresh confirmed reads for registration: the multisig and its spending limits. */
export async function readRegistrationSnapshot(rpc: SolanaRpc, cluster: SolanaClusterName, multisig: string, now: () => number = Date.now): Promise<OnchainSnapshot> {
  await assertCluster(rpc, cluster);
  const [[account], spendingLimitCount] = await Promise.all([rpc.accounts([multisig]), rpc.countSpendingLimits(multisig)]);
  return { observedAt: now(), multisig: account, spendingLimitCount };
}
/**
 * Fresh confirmed reads for a release: multisig, proposal, vault transaction, spending limits, a USDC destination,
 * and the deposit address's SOL with Solana's live rent-exempt minimum (a SOL release must not leave dust the chain
 * would refuse at execution). A failed balance or minimum read is recorded as null, so only a SOL release is refused.
 */
export async function readReleaseSnapshot(rpc: SolanaRpc, cluster: SolanaClusterName, request: { multisig: string; transactionIndex: string }, now: () => number = Date.now): Promise<OnchainSnapshot> {
  await assertCluster(rpc, cluster);
  const addresses = pairedVaultAddresses(request.multisig, parseTransactionIndex(request.transactionIndex));
  const optional = (read: (() => Promise<bigint>) | null) => read ? read().catch(() => null) : Promise.resolve(null);
  const [[multisig, proposal, transaction], spendingLimitCount, vaultLamports, rentExemptMinimum] = await Promise.all([
    rpc.accounts([request.multisig, addresses.proposal!, addresses.transaction!]),
    rpc.countSpendingLimits(request.multisig),
    optional(rpc.balance ? () => rpc.balance!(addresses.vault) : null),
    optional(rpc.rentExemptMinimum ? () => rpc.rentExemptMinimum!(0) : null),
  ]);
  const destination = releaseTokenDestination(transaction);
  const destinationTokenAccount = destination && isSolanaAddress(destination) ? (await rpc.accounts([destination]))[0] : null;
  return { observedAt: now(), multisig, proposal, transaction, spendingLimitCount, destinationTokenAccount, vaultLamports, rentExemptMinimum };
}

export interface GuardianAuditEvent {
  action: 'register' | 'approve';
  outcome: 'allowed' | 'denied' | 'already-approved' | 'already-registered' | 'pending' | 'error';
  privyUserId: string;
  multisig: string;
  transactionIndex?: string;
  reason?: string;
  asset?: string;
  amountRaw?: string;
  signature?: string;
}
export interface PairedVaultGuardianDependencies {
  guardian: GuardianSigner;
  rpc: SolanaRpc;
  cluster: SolanaClusterName;
  store: VaultStore;
  loadUser(privyUserId: string): Promise<PrivyUserFacts>;
  now?: () => number;
  audit?: (event: GuardianAuditEvent) => void;
  /** Global anti-abuse ceiling on guardian votes per rolling hour, bounding fee spend from G's SOL float. Not a money cap. */
  maxApprovalsPerHour?: number;
  /** Per-account anti-abuse ceilings on new vote reservations (counts, not amounts), so one account cannot drain G's fee SOL. */
  maxApprovalsPerUserPerHour?: number;
  maxApprovalsPerUserPerDay?: number;
  /** Test seam: how long account() waits for on-chain discovery (DISCOVERY_DEADLINE_MS by default). */
  discoveryDeadlineMs?: number;
}
/**
 * Vote-count ceilings that only stop abuse of the guardian's fee SOL (each vote costs G a network fee). Owner
 * decision 2026-10-13: set far above any normal use so they never block an ordinary release. They limit how many
 * votes, never how much value; release amounts are capped only by the user's own optional Limits layer.
 */
export const GUARDIAN_RATE_DEFAULTS = Object.freeze({ perHour: 2_000, perUserPerHour: 120, perUserPerDay: 2_000 });
export const GUARDIAN_RATE_ENV = Object.freeze({
  perHour: 'ANTARA_GUARDIAN_MAX_APPROVALS_PER_HOUR',
  perUserPerHour: 'ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR',
  perUserPerDay: 'ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY',
});
/**
 * A vote signed less than this long ago may still land (a blockhash lives about
 * 150 slots, roughly 60 to 90 seconds), so a repeat request is answered
 * "pending" instead of paying for a second vote.
 */
export const VOTE_PENDING_MS = 90_000;
const HOUR_MS = 60 * 60 * 1000, DAY_MS = 24 * HOUR_MS;
export type GuardianApproveResult =
  | { status: 'approved'; signature: string; asset: string; amountRaw: string; recipient: string }
  | { status: 'already-approved' }
  | { status: 'pending'; signature: string };
/** One of the account's linked Solana wallets, as the vault policy sees it (fresh from Privy). */
export interface GuardianAccountWallet {
  address: string;
  /** Privy embedded wallet (the only kind that can be U). */
  embedded: boolean;
  /** Why this wallet cannot be U of a paired vault, or null when it can. */
  pairProblem: string | null;
}
/**
 * A paired vault on Solana for one of the account's wallets and this guardian that is not registered with ANTARA yet
 * (its creation landed but registration never happened, or happened in another app). Decoded and verified exactly as
 * registration does, from public chain data; the client verifies it again before it registers it.
 */
export interface UnregisteredPairedVault { multisig: string; vault: string; user: string; guardian: string }
/** How long one account's on-chain discovery answer is reused: every surface reads account() when it opens. */
export const DISCOVERY_TTL_MS = 30_000;
/** account() waits at most this long for discovery; a slower or failed one is reported as not checked. */
export const DISCOVERY_DEADLINE_MS = 10_000;
/**
 * Bounds on discovery work: wallets searched per account, search matches checked per wallet (anyone can create
 * look-alike accounts that match the filters, so every match up to this bound is checked before any is dropped),
 * vaults reported, accounts remembered.
 */
export const DISCOVERY_LIMITS = Object.freeze({ wallets: 3, candidates: 50, vaults: 5, cachedAccounts: 1_000 });
export interface PairedVaultGuardian {
  /** Public guardian facts. Rejects (503) unless the Privy binding verifies and the store is readable. */
  config(): Promise<{ guardian: string; cluster: SolanaClusterName; policyVersion: string }>;
  /**
   * What this account can do now: linked Solana wallets and registered vaults. Read-only. `mfaEnrolled` is kept for
   * wire compatibility with clients that parse it and is always true: since 2026-10-13 no account-level (Privy) MFA
   * is required for a vault. The vault's own authenticator is reported by GET /solana/layers.
   *
   * `unregistered`: paired vaults found on Solana for the account's pairable wallets that have no vault registered with
   * this guardian, so any app can offer "Finish activation" instead of creating a second vault. Absent when that
   * check could not run (no discovery RPC, an RPC failure or the deadline); `[]` means it ran and found none.
   */
  account(privyUserId: string): Promise<{ mfaEnrolled: boolean; wallets: GuardianAccountWallet[]; vaults: ReturnType<PairedVaultGuardian['vaults']>['vaults']; unregistered?: UnregisteredPairedVault[] }>;
  register(privyUserId: string, body: unknown): Promise<{ status: 'registered' | 'already-registered'; multisig: string; vault: string; guardian: string }>;
  approve(privyUserId: string, body: unknown): Promise<GuardianApproveResult>;
  /** This account's registered paired vaults, so every surface (desktop, extension, web) sees the same list. */
  vaults(privyUserId: string): { vaults: Array<Pick<PairedVaultRecord, 'multisig' | 'vault' | 'user' | 'guardian' | 'createdAt'>> };
}
const defaultAudit = (event: GuardianAuditEvent) => console.info(JSON.stringify({ event: 'antara.guardian', at: new Date().toISOString(), ...event }));
function requestBody(body: unknown, withIndex: boolean) {
  const value = (body ?? {}) as { multisig?: unknown; transactionIndex?: unknown };
  if (!isSolanaAddress(value.multisig)) throw new GuardianError('Invalid vault address.', 400, 'invalid');
  if (!withIndex) return { multisig: value.multisig, transactionIndex: '' };
  if (typeof value.transactionIndex !== 'string' || !/^[1-9]\d{0,19}$/.test(value.transactionIndex)) throw new GuardianError('Invalid proposal index.', 400, 'invalid');
  try { parseTransactionIndex(value.transactionIndex); } catch { throw new GuardianError('Invalid proposal index.', 400, 'invalid'); }
  return { multisig: value.multisig, transactionIndex: value.transactionIndex };
}
function storeError(error: unknown): GuardianError {
  if (error instanceof GuardianError) return error;
  if (error instanceof VaultStoreError && error.code === 'conflict') return new GuardianError(error.message, 409, 'conflict');
  // Users get a generic answer; the operator log says why (for example an uninitialised or lost store). Store messages carry no values.
  if (error instanceof VaultStoreError) console.error(JSON.stringify({ event: 'antara.guardian.store', at: new Date().toISOString(), code: error.code, error: error.message }));
  return unavailable('Vault storage is unavailable. Nothing was approved.');
}

export function createPairedVaultGuardian(deps: PairedVaultGuardianDependencies): PairedVaultGuardian {
  const now = deps.now ?? Date.now;
  const audit = deps.audit ?? defaultAudit;
  const maxPerHour = deps.maxApprovalsPerHour ?? GUARDIAN_RATE_DEFAULTS.perHour;
  const maxPerUserHour = deps.maxApprovalsPerUserPerHour ?? GUARDIAN_RATE_DEFAULTS.perUserPerHour;
  const maxPerUserDay = deps.maxApprovalsPerUserPerDay ?? GUARDIAN_RATE_DEFAULTS.perUserPerDay;
  const sent: number[] = [];
  const inFlight = new Set<string>();
  const guardian = deps.guardian.address;
  const loadUser = async (privyUserId: string) => {
    try { return await deps.loadUser(privyUserId); } catch { throw unavailable('Your account could not be verified with Privy. Retry shortly.'); }
  };
  // No vault is registered, shown or co-signed unless G is provably the pinned, policy-bound Privy wallet.
  const verifyGuardian = async () => {
    try { await deps.guardian.verify(); }
    catch (error) { throw error instanceof GuardianError ? error : unavailable('The vault guardian could not be verified. Nothing was changed.'); }
  };
  const listVaults = (privyUserId: string) => {
    let records: PairedVaultRecord[];
    try { records = deps.store.vaultsForUser(privyUserId); } catch (error) { throw storeError(error); }
    return { vaults: records.map(({ multisig, vault, user, guardian: paired, createdAt }) => ({ multisig, vault, user, guardian: paired, createdAt })) };
  };
  // On-chain discovery of unregistered paired vaults, per account and wallet set, shared by concurrent reads for
  // DISCOVERY_TTL_MS. A failed search is forgotten at once, so the next read searches again.
  const discoveries = new Map<string, { at: number; result: Promise<UnregisteredPairedVault[]> }>();
  const discover = (privyUserId: string, wallets: string[], find: NonNullable<SolanaRpc['pairedMultisigs']>): Promise<UnregisteredPairedVault[]> => {
    const at = now();
    const fresh = (entry: { at: number }) => at - entry.at >= 0 && at - entry.at < DISCOVERY_TTL_MS;
    const key = `${privyUserId}\n${wallets.join(',')}`;
    const cached = discoveries.get(key);
    if (cached && fresh(cached)) return cached.result;
    for (const [id, entry] of discoveries) if (!fresh(entry)) discoveries.delete(id);
    while (discoveries.size >= DISCOVERY_LIMITS.cachedAccounts) discoveries.delete(discoveries.keys().next().value as string);
    const result = (async () => {
      await assertCluster(deps.rpc, deps.cluster);
      // Exactly what registration accepts for this wallet and guardian; anything else is not offered.
      const exact = (account: RawSolanaAccount, wallet: string, spendingLimitCount: number): UnregisteredPairedVault | null => {
        try {
          const state = decodePairedMultisig(account, { guardian, user: wallet, spendingLimitCount });
          return { multisig: state.address, vault: state.vault, user: state.user, guardian: state.guardian };
        } catch (error) { if (error instanceof PairedVaultDecodeError) return null; throw error; }
      };
      const perWallet = await Promise.all(wallets.map(async wallet => {
        // Every match is checked locally first (no RPC), so look-alikes that fail the rules cannot crowd out the
        // real vault; spending limits are then read only for exact shapes, a few at a time, until enough are found.
        const shaped = (await find(wallet, guardian)).slice(0, DISCOVERY_LIMITS.candidates).filter(account => exact(account, wallet, 0) !== null);
        const found: UnregisteredPairedVault[] = [];
        for (let start = 0; start < shaped.length && found.length < DISCOVERY_LIMITS.vaults; start += DISCOVERY_LIMITS.vaults) {
          const checked = await Promise.all(shaped.slice(start, start + DISCOVERY_LIMITS.vaults).map(async account =>
            exact(account, wallet, await deps.rpc.countSpendingLimits(account.address))));
          found.push(...checked.filter((item): item is UnregisteredPairedVault => item !== null));
        }
        return found;
      }));
      return perWallet.flat().slice(0, DISCOVERY_LIMITS.vaults);
    })();
    const entry = { at, result };
    discoveries.set(key, entry);
    result.catch(() => { if (discoveries.get(key) === entry) discoveries.delete(key); });
    return result;
  };
  /** The account's unregistered paired vaults with this guardian, or undefined when they could not be looked up. */
  const unregisteredVaults = async (user: PrivyUserFacts, registered: ReadonlyArray<Pick<PairedVaultRecord, 'user' | 'guardian'>>): Promise<UnregisteredPairedVault[] | undefined> => {
    const find = deps.rpc.pairedMultisigs?.bind(deps.rpc);
    if (!find) return undefined;
    // Only wallets that can pair and have no vault registered with this guardian (the common case costs no RPC call).
    const wallets = [...new Set(user.solanaWallets
      .filter(wallet => !pairedWalletProblem(wallet) && wallet.address !== guardian && isSolanaWalletAddress(wallet.address) &&
        !registered.some(item => item.user === wallet.address && item.guardian === guardian))
      .map(wallet => wallet.address))].sort().slice(0, DISCOVERY_LIMITS.wallets);
    if (!wallets.length) return [];
    let found: UnregisteredPairedVault[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      found = await Promise.race([
        discover(user.id, wallets, find),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), deps.discoveryDeadlineMs ?? DISCOVERY_DEADLINE_MS); timer.unref?.(); }),
      ]);
    } catch {
      // Operator log only: no address, account or RPC detail.
      console.error(JSON.stringify({ event: 'antara.guardian.discovery', at: new Date().toISOString(), outcome: 'unavailable' }));
      return undefined;
    } finally { clearTimeout(timer); }
    // A vault registered since (by this or any account) is not offered again.
    try { return found.filter(item => !deps.store.getVault(item.multisig)); } catch (error) { throw storeError(error); }
  };
  return {
    async config() {
      await verifyGuardian();
      try { deps.store.ledger(); } catch (error) { throw storeError(error); }
      return { guardian, cluster: deps.cluster, policyVersion: PAIRED_POLICY_VERSION };
    },
    async register(privyUserId, body) {
      const { multisig } = requestBody(body, false);
      await verifyGuardian();
      const user = await loadUser(privyUserId);
      let onchain: OnchainSnapshot;
      try { onchain = await readRegistrationSnapshot(deps.rpc, deps.cluster, multisig, now); } catch { throw unavailable('The vault could not be read from the Solana network. Try again.'); }
      const decision = evaluateRegistration({ user, guardian, request: { multisig }, onchain, now: now() });
      if (!decision.allow) {
        audit({ action: 'register', outcome: 'denied', privyUserId, multisig, reason: decision.reason });
        throw new GuardianError(decision.reason, decision.status, decision.status === 403 ? 'denied' : decision.status === 409 ? 'conflict' : 'unavailable');
      }
      let result: ReturnType<VaultStore['registerVault']>;
      try { result = await deps.store.withLock(() => deps.store.registerVault(decision.record)); } catch (error) { throw storeError(error); }
      audit({ action: 'register', outcome: result.created ? 'allowed' : 'already-registered', privyUserId, multisig });
      return { status: result.created ? 'registered' : 'already-registered', multisig, vault: result.record.vault, guardian };
    },
    async approve(privyUserId, body) {
      const request = requestBody(body, true);
      // Keyed by account: multisig addresses and indexes are public, so another account's
      // requests (refused later as "another account") must never hold the owner's slot.
      // Reservation and signing across requests are still serialised by the store lock and ledger.
      const key = `${privyUserId}:${request.multisig}:${request.transactionIndex}`;
      if (inFlight.has(key)) throw new GuardianError('An approval for this proposal is already in progress.', 409, 'conflict');
      inFlight.add(key);
      try {
        // Before any reservation: a binding failure must never reserve a vote.
        await verifyGuardian();
        const user = await loadUser(privyUserId);
        let registration: PairedVaultRecord | null;
        try { registration = deps.store.getVault(request.multisig); } catch (error) { throw storeError(error); }
        if (!registration) throw new GuardianError('This vault is not registered with ANTARA. Activate it again.', 409, 'conflict');
        if (registration.privyUserId !== user.id) {
          audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: 'vault registered to another account' });
          throw new GuardianError('This vault belongs to another account.', 403, 'denied');
        }
        let onchain: OnchainSnapshot;
        try { onchain = await readReleaseSnapshot(deps.rpc, deps.cluster, request, now); } catch { throw unavailable('The vault could not be read from the Solana network. Try again.'); }
        type Reservation = { kind: 'already-approved' } | { kind: 'pending'; signature: string } | { kind: 'reserved'; entry: LedgerEntry };
        const reservation = await deps.store.withLock((): Reservation => {
          const at = now();
          // The vault's own caps (Limits layer, when set) were checked by the layer step and are re-checked by the store
          // against the release authorization in this same locked section (vaultStore.ts); there is no server-wide cap.
          const decision = evaluateRelease({ user, guardian, registration, request, onchain, limits: NO_RELEASE_LIMITS, ledger: () => deps.store.ledger(), now: at });
          if (!decision.allow) {
            if (decision.alreadyApproved) { audit({ action: 'approve', outcome: 'already-approved', privyUserId, ...request }); return { kind: 'already-approved' }; }
            audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: decision.reason });
            throw new GuardianError(decision.reason, decision.status, decision.status === 403 ? 'denied' : decision.status === 409 ? 'conflict' : 'unavailable');
          }
          try {
            const existing = deps.store.ledgerEntry(request.multisig, decision.entry.transactionIndex);
            // A vote that may still land is not paid for twice.
            if (existing?.signature && existing.signedAt && at - Date.parse(existing.signedAt) < VOTE_PENDING_MS) {
              audit({ action: 'approve', outcome: 'pending', privyUserId, ...request, signature: existing.signature });
              return { kind: 'pending', signature: existing.signature };
            }
            if (!existing) {
              const ledger = deps.store.ledger();
              if (approvalsInWindow(ledger, user.id, at, HOUR_MS) >= maxPerUserHour || approvalsInWindow(ledger, user.id, at, DAY_MS) >= maxPerUserDay) {
                audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: 'per-account vote cap' });
                throw new GuardianError('You have requested many vault releases recently. Try again later.', 429, 'busy');
              }
            }
            while (sent.length && at - sent[0] >= HOUR_MS) sent.shift();
            if (sent.length >= maxPerHour) throw new GuardianError('ANTARA is approving many releases right now. Try again shortly.', 429, 'busy');
            deps.store.recordApproval(decision.entry, at);
          } catch (error) { throw storeError(error); }
          sent.push(at);
          return { kind: 'reserved', entry: decision.entry };
        });
        if (reservation.kind === 'already-approved') return { status: 'already-approved' };
        if (reservation.kind === 'pending') return { status: 'pending', signature: reservation.signature };
        const reserved = reservation.entry;
        let signature: string;
        try { ({ signature } = await deps.guardian.approve(request)); }
        catch (error) {
          audit({ action: 'approve', outcome: 'error', privyUserId, ...request, reason: error instanceof GuardianError ? error.message : 'signing failed' });
          if (error instanceof GuardianError && error.status !== 503) throw error;
          throw unavailable('The guardian could not submit its approval. Retry shortly; this release stays reserved for this proposal.');
        }
        try { await deps.store.withLock(() => { const at = now(); return deps.store.recordApproval({ ...reserved, signature, signedAt: new Date(at).toISOString() }, at); }); }
        catch { audit({ action: 'approve', outcome: 'error', privyUserId, ...request, reason: 'signature not recorded' }); }
        audit({ action: 'approve', outcome: 'allowed', privyUserId, ...request, asset: reserved.asset, amountRaw: reserved.amountRaw, signature });
        return { status: 'approved', signature, asset: reserved.asset, amountRaw: reserved.amountRaw, recipient: reserved.recipient };
      } finally { inFlight.delete(key); }
    },
    vaults: listVaults,
    async account(privyUserId) {
      const user = await loadUser(privyUserId);
      if (user.id !== privyUserId) throw unavailable('Your account could not be verified with Privy. Retry shortly.');
      const { vaults } = listVaults(privyUserId);
      const unregistered = await unregisteredVaults(user, vaults);
      return {
        // Compatibility only (see account() above): no account-level MFA requirement blocks this account.
        mfaEnrolled: true,
        // Every linked wallet can receive releases as soon as it is linked (no link-age wait since 2026-10-13).
        wallets: user.solanaWallets.map(wallet => ({ address: wallet.address, embedded: wallet.embedded, pairProblem: pairedWalletProblem(wallet) })),
        vaults,
        ...(unregistered ? { unregistered } : {}),
      };
    },
  };
}

/** Guardian vote caps from the environment. A malformed override disables the guardian rather than falling back. */
export function guardianRateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const read = (key: keyof typeof GUARDIAN_RATE_ENV, ceiling: number) => {
    const raw = env[GUARDIAN_RATE_ENV[key]]?.trim();
    if (!raw) return GUARDIAN_RATE_DEFAULTS[key];
    const value = /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value > ceiling) throw unavailable(`${GUARDIAN_RATE_ENV[key]} must be a whole number from 1 to ${ceiling}.`);
    return value;
  };
  const limits = { perHour: read('perHour', 100_000), perUserPerHour: read('perUserPerHour', 10_000), perUserPerDay: read('perUserPerDay', 100_000) };
  if (limits.perUserPerHour > limits.perUserPerDay) throw unavailable(`${GUARDIAN_RATE_ENV.perUserPerHour} cannot exceed ${GUARDIAN_RATE_ENV.perUserPerDay}.`);
  return limits;
}

/**
 * Production wiring. Throws GuardianError (503) when any guardian setting,
 * vote-rate setting or DATA_DIR is missing or invalid, so routes can report
 * "unavailable".
 */
export function pairedVaultGuardianFromEnv(options: { privy: PrivyClient; rpcUrl: string; env?: NodeJS.ProcessEnv; store?: VaultStore; fetch?: typeof fetch }): PairedVaultGuardian {
  const env = options.env ?? process.env;
  const config = readGuardianConfig(env);
  const rates = guardianRateLimitsFromEnv(env);
  let store: VaultStore;
  try { store = options.store ?? createVaultStore(vaultStorePath(env), vaultStoreOptions(env)); } catch (error) { throw unavailable(error instanceof Error ? error.message : 'Vault storage is not configured.'); }
  const rpc = solanaJsonRpc(options.rpcUrl, { fetch: options.fetch });
  return createPairedVaultGuardian({
    guardian: createGuardianSigner({ config, client: privyGuardianClient(options.privy), latestBlockhash: () => rpc.latestBlockhash() }),
    rpc, cluster: config.cluster, store,
    loadUser: async id => privyUserFacts(await options.privy.users()._get(id)),
    maxApprovalsPerHour: rates.perHour, maxApprovalsPerUserPerHour: rates.perUserPerHour, maxApprovalsPerUserPerDay: rates.perUserPerDay,
  });
}
