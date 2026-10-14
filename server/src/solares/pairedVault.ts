import { PREDETERMINED_SALT_NONCE } from '@safe-global/protocol-kit';
import { getCompatibilityFallbackHandlerDeployments, getProxyFactoryDeployments, getSafeL2SingletonDeployments, getSafeSingletonDeployments, type DeploymentFilter, type SingletonDeploymentV2 } from '@safe-global/safe-deployments';
import { PrivyClient } from '@privy-io/node';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { concat, createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, http, isAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { publicCosignerAddress } from '../providers/cosigner.js';
import { CLIENT_IP_HEADER, TRUST_PROXY, serverRpcUrl } from '../config.js';
import { LEGACY_NETWORKS, SOLANA_NETWORK, SUPPORTED_EVM_NETWORKS, byKey, isLegacyNetworkKey, isNetworkKey, type EvmNetworkKey } from '../../../src/solares/networks';
import { VIEM_CHAINS } from '../../../src/solares/evmChains';
import { GUARDIAN_ENV, GuardianError, pairedVaultGuardianFromEnv, type PairedVaultGuardian } from './guardian.js';
import { LayerError } from './layers/errors.js';
import { vaultLayerServiceFromEnv, type LayerRequestContext, type VaultLayerService } from './layers/service.js';
import { initialiseVaultStoreAtBoot, type VaultStoreBootResult } from './vaultStore.js';
import { WALLET_NOT_LINKED, isOwnedAddress, limitBeforeAuth, requirePrivyUser } from './wallet.js';
import { rateLimit } from './rateLimit.js';
import { clientIp } from './clientIp.js';

/** Networks with canonical Safe deployments per the registry: Ethereum, BNB Smart Chain, Robinhood Chain, Base. */
export const PAIRED_VAULT_NETWORKS: readonly EvmNetworkKey[] = Object.freeze(SUPPORTED_EVM_NETWORKS.filter(network => network.safeSupported).map(network => network.key));
const SOLANA_PAIRED = 'This check covers EVM Safe vaults only. Paired Solana vaults are Squads vaults co-signed by the ANTARA guardian and use the Solana vault routes.';

/** The guardian is not configured, or paired vaults are not switched on, on this server. Names no variable and echoes no value. */
export class GuardianNotProvisionedError extends Error {
  constructor() { super('The ANTARA vault guardian is not enabled on this server.'); this.name = 'GuardianNotProvisionedError'; }
}
export const GUARDIAN_NOT_PROVISIONED = 'The ANTARA vault guardian is not enabled on this server yet. Paired Solana vaults are unavailable; nothing was created or approved.';
/**
 * Owner switch for paired Solana vaults. Until it is exactly "true", every Solana
 * vault route answers 503 `not-provisioned`, even with every guardian setting in
 * place, so nobody can activate or deposit before both go-live gates
 * (--verify-policy, --probe-user-jwt) are recorded in docs/VERIFICATION.md.
 */
export const PAIRED_VAULTS_ENABLED_ENV = 'ANTARA_PAIRED_VAULTS_ENABLED';
export function pairedVaultsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PAIRED_VAULTS_ENABLED_ENV]?.trim() === 'true';
}

export interface PairedVaultConfig { owners: Address[]; threshold: number }
export interface PairedVaultDependencies {
  authenticate: RequestHandler;
  configured: () => boolean;
  cosigner: () => Address;
  /** `signal` aborts when the discovery deadline passes; outstanding reads must stop. */
  predict: (chain: EvmNetworkKey, config: PairedVaultConfig, signal?: AbortSignal) => Promise<Address>;
  deployed: (chain: EvmNetworkKey, address: Address, signal?: AbortSignal) => Promise<boolean>;
  /** Budget for one discovery's RPC reads; a stalled RPC is reported as an error. */
  timeoutMs?: number;
  /**
   * Lazily built Solana guardian service (paired Squads vaults). Throws
   * GuardianNotProvisionedError when the guardian is not configured, or a
   * GuardianError(503) for any other setup problem. Omitted: Solana routes 503.
   */
  solanaGuardian?: () => PairedVaultGuardian;
  /**
   * Lazily built vault protection-layer service (layers/service.ts), with the
   * same not-provisioned and 503 rules as solanaGuardian. Omitted: the layer
   * routes and every vote answer 503, because a release needs its passkey.
   */
  solanaLayers?: () => VaultLayerService;
  /** Runs once when the router is built. Production opens the paired-vault store at start-up (vaultStore.ts). */
  initialiseStore?: () => void;
}

let solanaGuardianService: PairedVaultGuardian | null = null;
/**
 * Production guardian service, built once from the environment. Nothing is
 * cached on failure, so a later request retries after the operator fixes the
 * configuration (a restart is still needed for changed values).
 */
export function defaultSolanaGuardian(): PairedVaultGuardian {
  // Switched off: answered exactly like an unprovisioned guardian, before anything is built or read.
  if (!pairedVaultsEnabled()) throw new GuardianNotProvisionedError();
  if (solanaGuardianService) return solanaGuardianService;
  if (Object.values(GUARDIAN_ENV).some(name => !process.env[name]?.trim())) throw new GuardianNotProvisionedError();
  const appId = process.env.PRIVY_APP_ID?.trim(), appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new GuardianError('Privy server authentication is not configured.', 503, 'unavailable');
  try {
    return solanaGuardianService = pairedVaultGuardianFromEnv({ privy: new PrivyClient({ appId, appSecret }), rpcUrl: serverRpcUrl(SOLANA_NETWORK) });
  } catch (error) {
    // The operator sees which setting is wrong (names only, never values); clients get a generic answer.
    console.error(JSON.stringify({ event: 'antara.guardian', outcome: 'misconfigured', reason: error instanceof Error ? error.message : 'unknown' }));
    throw new GuardianError('The vault guardian is misconfigured on this server. Nothing was created or approved.', 503, 'unavailable');
  }
}

let layerService: VaultLayerService | null = null;
/** Production protection-layer service, built once from the same environment as the guardian; nothing is cached on failure. */
export function defaultLayerService(): VaultLayerService {
  if (!pairedVaultsEnabled()) throw new GuardianNotProvisionedError();
  if (layerService) return layerService;
  if (Object.values(GUARDIAN_ENV).some(name => !process.env[name]?.trim())) throw new GuardianNotProvisionedError();
  const appId = process.env.PRIVY_APP_ID?.trim(), appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new GuardianError('Privy server authentication is not configured.', 503, 'unavailable');
  try {
    return layerService = vaultLayerServiceFromEnv({ privy: new PrivyClient({ appId, appSecret }), rpcUrl: serverRpcUrl(SOLANA_NETWORK), trustProxy: TRUST_PROXY, clientIpHeader: CLIENT_IP_HEADER });
  } catch (error) {
    console.error(JSON.stringify({ event: 'antara.guardian.layers', outcome: 'misconfigured', reason: error instanceof Error ? error.message : 'unknown' }));
    throw new GuardianError('Vault protection layers are misconfigured on this server. Nothing was created or approved.', 503, 'unavailable');
  }
}

/**
 * Opens the paired-vault store once at server start, independent of the guardian
 * settings and the owner switch, and logs the outcome (ANTARA's own text and
 * names only). A deliberate fresh install (ANTARA_VAULT_STORE_INIT=1) therefore
 * writes its marker during that start, and a wrong DATA_DIR or lost store is
 * visible at boot rather than on the first vault request.
 */
export function openVaultStoreAtBoot(env: NodeJS.ProcessEnv = process.env): VaultStoreBootResult {
  const result = initialiseVaultStoreAtBoot(env);
  if (result.outcome === 'ready' && env.NODE_ENV !== 'production') return result;
  const line = JSON.stringify({ event: 'antara.vault-store', at: new Date().toISOString(), ...result });
  if (result.outcome === 'refused') console.error(line); else console.info(line);
  return result;
}

// Each read first proves the RPC serves the expected chain: a misconfigured URL
// must never yield another network's address or deployment state. Every read is
// bounded (8 s, no retries) and the discovery deadline's signal cancels it.
async function verifiedClient(chain: EvmNetworkKey, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const network = byKey(chain);
  const url = serverRpcUrl(network);
  const fetchFn: typeof fetch | undefined = signal && ((input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }));
  const client = createPublicClient({ chain: VIEM_CHAINS[chain], transport: http(url, { timeout: 8_000, retryCount: 0, fetchFn }) });
  if (await client.getChainId() !== network.evmChainId) throw new Error('RPC chain mismatch');
  return { network, url, client };
}

/** Safe version providers/safe.ts deploys for the ARK pairing (protocol-kit's DEFAULT_SAFE_VERSION). */
const SAFE_VERSION = '1.4.1';
const SAFE_SETUP_ABI = parseAbi(['function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);
const PROXY_FACTORY_ABI = parseAbi(['function proxyCreationCode() pure returns (bytes)']);
interface SafeDeployment { factory: Address; singleton: Address; fallbackHandler: Address; proxyCreationCode: Hex }
// Only verified results are kept (canonical contract code cannot be removed), so
// one failed or aborted read is retried on the next discovery instead of pinning
// a permanent error. protocol-kit's own module cache keeps rejected reads.
const verifiedDeployments = new Map<string, SafeDeployment>();

function canonicalAddress(lookup: (filter: DeploymentFilter) => SingletonDeploymentV2 | undefined, chainId: number): Address {
  // protocol-kit's resolution: the network's entry, or its first address when several are listed.
  const entry = lookup({ network: String(chainId), version: SAFE_VERSION, released: true })?.networkAddresses[String(chainId)];
  const address = Array.isArray(entry) ? entry[0] : entry;
  if (!address || !isAddress(address)) throw new Error('Safe deployment unavailable');
  return getAddress(address);
}
async function safeDeployment(chain: EvmNetworkKey, url: string, client: Awaited<ReturnType<typeof verifiedClient>>['client']): Promise<SafeDeployment> {
  const network = byKey(chain);
  const key = `${chain} ${url}`;
  const cached = verifiedDeployments.get(key);
  if (cached) return cached;
  const chainId = network.evmChainId;
  // Ethereum uses the L1 singleton; every other network the L2 one, as protocol-kit selects.
  const singleton = canonicalAddress(chainId === 1 ? getSafeSingletonDeployments : getSafeL2SingletonDeployments, chainId);
  const factory = canonicalAddress(getProxyFactoryDeployments, chainId);
  const fallbackHandler = canonicalAddress(getCompatibilityFallbackHandlerDeployments, chainId);
  const codes = await Promise.all([factory, singleton, fallbackHandler].map(address => client.getCode({ address })));
  if (codes.some(code => !code || code === '0x')) throw new Error('Safe deployment unavailable');
  const proxyCreationCode = await client.readContract({ address: factory, abi: PROXY_FACTORY_ABI, functionName: 'proxyCreationCode' });
  if (proxyCreationCode === '0x') throw new Error('Safe deployment unavailable');
  const deployment = { factory, singleton, fallbackHandler, proxyCreationCode };
  verifiedDeployments.set(key, deployment);
  return deployment;
}
/**
 * Deterministic address of the original ARK pairing, as providers/safe.ts
 * predicts it with protocol-kit defaults (Safe 1.4.1, canonical deployments,
 * compatibility fallback handler, chain-specific default salt nonce). It is
 * computed here so every read stays bounded and cancellable; tests pin it to
 * protocol-kit's prediction on every Safe network. Robinhood Chain (4663) needs
 * a @safe-global/safe-deployments release that lists it (1.37.63 does; 1.37.56
 * does not), or discovery there fails closed.
 */
export async function predictPairedVault(chain: EvmNetworkKey, config: PairedVaultConfig, signal?: AbortSignal): Promise<Address> {
  const { network, url, client } = await verifiedClient(chain, signal);
  const { factory, singleton, fallbackHandler, proxyCreationCode } = await safeDeployment(chain, url, client);
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI, functionName: 'setup',
    args: [config.owners, BigInt(config.threshold), zeroAddress, '0x', fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
  const saltNonce = keccak256(toHex(`${PREDETERMINED_SALT_NONCE}${network.evmChainId}`));
  const salt = keccak256(concat([keccak256(initializer), encodeAbiParameters([{ type: 'uint256' }], [BigInt(saltNonce)])]));
  const bytecode = concat([proxyCreationCode, encodeAbiParameters([{ type: 'address' }], [singleton])]);
  return getAddress(getContractAddress({ from: factory, bytecode, opcode: 'CREATE2', salt }));
}
export async function isPairedVaultDeployed(chain: EvmNetworkKey, address: Address, signal?: AbortSignal): Promise<boolean> {
  const { client } = await verifiedClient(chain, signal);
  const code = await client.getCode({ address });
  return code != null && code !== '0x';
}
// At the deadline the discovery fails and its signal aborts every outstanding read.
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Vault discovery deadline exceeded')); controller.abort(); }, timeoutMs);
    work(controller.signal).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// EVM: ARK pairs the wallet with the policy signer using the original
// deterministic Safe configuration. Discovery is read-only; legacy policy
// writes/signing are deliberately NOT exposed through the Privy API. The
// co-signer identity comes from public COSIGNER_ADDRESS when configured.
// Solana: paired Squads vaults {U:7, G:2}, threshold 2, co-signed by the ANTARA
// guardian (guardian.ts, vaultPolicy.ts). Every /solana route is authenticated,
// and register/approve are rate limited per account; the guardian service
// re-reads the Privy user (linked wallets, TOTP enrollment) and the chain itself.
export function pairedVaultRouter(dependencies: PairedVaultDependencies = {
  authenticate: requirePrivyUser,
  configured: () => publicCosignerAddress() !== null,
  cosigner: (): Address => { const address = publicCosignerAddress(); if (!address) throw new Error('Co-signer address is not configured.'); return address; },
  predict: predictPairedVault,
  deployed: isPairedVaultDeployed,
  solanaGuardian: defaultSolanaGuardian,
  solanaLayers: defaultLayerService,
  initialiseStore: () => { openVaultStoreAtBoot(); },
}) {
  dependencies.initialiseStore?.();
  const router = Router();
  // Each discovery fans out to several RPC calls, so each account is rate limited
  // (after a coarse per-IP limit that also bounds Privy authentication calls).
  router.use(limitBeforeAuth(), dependencies.authenticate, rateLimit({ max: 60, message: 'Please wait before checking your vault again.' }));
  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const owner = String(req.query.owner || '');
    const chain = String(req.query.chain || '');
    if (!isNetworkKey(chain) && !isLegacyNetworkKey(chain)) {
      res.status(400).json({ error: 'Unsupported network.' }); return;
    }
    if (!isOwnedAddress(req.solaresUser, owner, chain === 'solana' ? 'solana' : 'ethereum')) {
      res.status(403).json({ error: 'This wallet is not linked to your account.', code: WALLET_NOT_LINKED, chain: chain === 'solana' ? 'solana' : 'ethereum' }); return;
    }
    const context = { owner, chain, creationEnabled: false, transfersEnabled: false };
    // Saved Arbitrum or Polygon selections render as unsupported; nothing is read or substituted.
    if (!isNetworkKey(chain)) {
      const legacy = LEGACY_NETWORKS.find(network => network.key === chain);
      res.json({ ...context, status: 'unsupported', message: `${legacy?.name ?? 'This network'} is no longer supported by ANTARA.` }); return;
    }
    const network = byKey(chain);
    if (network.vm !== 'evm' || !PAIRED_VAULT_NETWORKS.includes(network.key)) {
      res.json({ ...context, status: 'unsupported', message: network.vm === 'svm' ? SOLANA_PAIRED : `Paired vaults are not available on ${network.name}.` }); return;
    }
    if (!isAddress(owner)) { res.status(400).json({ error: 'Invalid wallet address.' }); return; }
    const evmContext = { ...context, chainId: network.evmChainId };
    if (!dependencies.configured()) {
      res.json({ ...evmContext, status: 'unavailable' }); return;
    }
    try {
      const cosigner = dependencies.cosigner();
      const { address, deployed } = await withDeadline(async signal => {
        const address = await dependencies.predict(network.key, { owners: [owner, cosigner], threshold: 2 }, signal);
        return { address, deployed: await dependencies.deployed(network.key, address, signal) };
      }, dependencies.timeoutMs ?? 15_000);
      // Never present an undeployed address as a deposit destination.
      res.json({ ...evmContext, status: deployed ? 'deployed' : 'not-created', ...(deployed ? { address, cosigner } : {}) });
    } catch {
      res.status(503).json({ error: 'Your vault could not be checked. Please try again.' });
    }
  });

  // Paired Solana vaults. Authentication (above) runs before every route here.
  // Register and approve also get a tight per-account limit: each one reads the
  // Privy user and the chain, and approve can spend the guardian's fee float.
  const guardianWriteLimit = rateLimit({ max: 10, scope: () => 'guardian-write', message: 'Please wait before sending another vault request.' });
  const guardianRoute = (handler: (guardian: PairedVaultGuardian, req: Request, res: Response) => unknown): RequestHandler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!req.solaresUser?.id) { res.status(401).json({ error: 'A valid Privy session is required.' }); return; }
      if (!dependencies.solanaGuardian) throw new GuardianNotProvisionedError();
      await handler(dependencies.solanaGuardian(), req, res);
    } catch (error) {
      if (error instanceof GuardianNotProvisionedError) { res.status(503).json({ error: GUARDIAN_NOT_PROVISIONED, code: 'not-provisioned' }); return; }
      if (error instanceof LayerError) {
        const retryAfterSeconds = error.status === 429 ? Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60)) : null;
        if (retryAfterSeconds !== null) res.setHeader('Retry-After', String(retryAfterSeconds));
        // Only the defined shapes are passed through: the requirement list, the per-layer results, or the
        // lockout wait. The wait is also in the body because a cross-origin client (Desktop, the extension)
        // can read Retry-After only when CORS exposes it (server/src/index.ts does).
        const extra = error.code === 'layers-required' && error.extra.required ? { required: error.extra.required }
          : error.code === 'layer-failed' && error.extra.layers ? { layers: error.extra.layers.map(({ id, ok, reason }) => ({ id, ok, ...(reason ? { reason } : {}) })) }
          : error.code === 'locked' && retryAfterSeconds !== null ? { retryAfterSeconds } : {};
        res.status(error.status).json({ error: error.message, code: error.code, ...extra }); return;
      }
      if (error instanceof GuardianError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        // GuardianError messages are ANTARA's own text and never carry a configuration value.
        res.status(error.status).json({ error: error.message, code: error.code }); return;
      }
      res.status(503).json({ error: 'The vault guardian is unavailable. Nothing was approved.', code: 'unavailable' });
    }
  };
  const userId = (req: Request) => req.solaresUser!.id;
  const layerContext = (req: Request): LayerRequestContext => {
    // The Privy session id that authentication recorded (requirePrivyUser, from verifyAccessToken().session_id). Every
    // challenge is bound to it; without one the layer service refuses (503) rather than treat all sessions as one.
    const session = (req.solaresUser as { sessionId?: unknown } | undefined)?.sessionId;
    return { ip: clientIp(req) ?? null, sessionId: typeof session === 'string' && session.length > 0 && session.length <= 200 ? session : null };
  };
  // Public guardian facts: address, cluster and policy version. There are no server-wide release limits.
  router.get('/solana/config', guardianRoute(async (guardian, _req, res) => { res.json({ configured: true, ...(await guardian.config()) }); }));
  // This account's linked Solana wallets (which can pair; every linked wallet can receive releases) and registered vaults.
  router.get('/solana/account', guardianRoute(async (guardian, req, res) => { res.json(await guardian.account(userId(req))); }));
  router.get('/solana/vaults', guardianRoute((guardian, req, res) => { res.json(guardian.vaults(userId(req))); }));
  router.post('/solana/register', guardianWriteLimit, guardianRoute(async (guardian, req, res) => {
    const result = await guardian.register(userId(req), req.body);
    // A vault registered just now gets its first-passkey window for this session only (layers/service.ts, stored with the
    // registration). `already-registered` opens one only for a vault registered before this server started, still inside that time with no passkey and no window
    // recorded. Without the layer service, or on any failure, no window opens and the first passkey is a 7-day recovery
    // change: fails closed.
    if (dependencies.solanaLayers) {
      try { await dependencies.solanaLayers().noteRegistration(userId(req), result.multisig, layerContext(req), result.status); }
      catch { console.error(JSON.stringify({ event: 'antara.guardian.layers', outcome: 'error', reason: 'first-passkey window not opened' })); }
    }
    res.json(result);
  }));
  // Vault protection layers (docs/VAULT_LAYERS.md §9). Every layer route needs a provisioned guardian whose
  // Privy binding verifies and a readable store; evidence-bearing routes are also locked out after 5 failures.
  const layersWriteLimit = rateLimit({ max: 20, scope: () => 'layers-write', message: 'Please wait before changing vault protection again.' });
  const layersBeginLimit = rateLimit({ max: 10, scope: () => 'layers-begin', message: 'Please wait before starting another vault protection change.' });
  const layerRoute = (handler: (layers: VaultLayerService, guardian: PairedVaultGuardian, req: Request, res: Response) => unknown): RequestHandler =>
    guardianRoute(async (guardian, req, res) => {
      if (!dependencies.solanaLayers) throw new GuardianNotProvisionedError();
      const layers = dependencies.solanaLayers();
      await guardian.config();
      await handler(layers, guardian, req, res);
    });
  router.get('/solana/layers', layerRoute(async (layers, _guardian, req, res) => { res.json(await layers.list(userId(req), req.query.multisig, layerContext(req))); }));
  router.post('/solana/layers/approval/begin', layersWriteLimit, layerRoute(async (layers, _guardian, req, res) => {
    res.json(await layers.beginApproval(userId(req), req.body, layerContext(req)));
  }));
  for (const route of ['enroll', 'change'] as const) {
    router.post(`/solana/layers/${route}/begin`, layersWriteLimit, layersBeginLimit, layerRoute(async (layers, _guardian, req, res) => {
      res.json(await layers.beginChange(userId(req), req.body, route, layerContext(req)));
    }));
    router.post(`/solana/layers/${route}/finish`, layersWriteLimit, layerRoute(async (layers, _guardian, req, res) => {
      res.json(await layers.finishChange(userId(req), req.body, route, layerContext(req)));
    }));
  }
  router.post('/solana/layers/change/cancel', layersWriteLimit, layerRoute(async (layers, _guardian, req, res) => {
    res.json(await layers.cancelChange(userId(req), req.body, layerContext(req)));
  }));
  // A vote passes the layer step first (a passkey is required for every release); only then may the
  // guardian service reserve and sign. The layer step grants the store's single-use release
  // authorization, and the server's stores refuse any reservation without one, re-checking any caps the
  // user set for the vault in the reservation's locked section and recording the layers that passed on it
  // (vaultStore.ts). So calling guardian.approve anywhere else cannot skip the layers. One approval per
  // account at a time as well, keyed by account, so nobody else's request can hold the owner's slot.
  const approvalsInFlight = new Set<string>();
  router.post('/solana/approve', guardianWriteLimit, layerRoute(async (layers, guardian, req, res) => {
    const key = userId(req);
    if (approvalsInFlight.has(key)) throw new GuardianError('An approval for this account is already in progress.', 409, 'conflict');
    approvalsInFlight.add(key);
    try {
      const authorization = await layers.authorizeRelease(userId(req), req.body, layerContext(req));
      if (authorization.kind === 'already-approved') { res.json({ status: 'already-approved' }); return; }
      if (authorization.kind === 'pending') { res.json({ status: 'pending', signature: authorization.signature }); return; }
      res.json(await guardian.approve(userId(req), authorization.request));
    } finally { approvalsInFlight.delete(key); }
  }));
  // The caps the user set for one vault (optional Limits layer; none by default) and that vault's releases in the last 24 hours.
  router.get('/limits', layerRoute(async (layers, _guardian, req, res) => { res.json(await layers.limits(userId(req), req.query.multisig)); }));
  return router;
}
