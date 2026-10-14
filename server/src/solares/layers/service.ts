/**
 * Vault protection-layer service (docs/VAULT_LAYERS.md §7 to §9): the layer
 * routes, and the layer step every guardian vote passes through.
 *
 * Fail-closed rules:
 * - a Biometrics passkey is required for every release (owner decision): a
 *   vault without one cannot release, whatever else is enabled
 * - every enabled layer is checked; anything missing, malformed, expired,
 *   reused or stale denies
 * - evidence is bound to the exact release (fresh on-chain transaction bytes
 *   and decoded intent) or change (normalised op and config version) through
 *   a single-use, in-memory nonce with a 5-minute TTL
 * - an unreadable store, invalid passkey settings or an unobservable network
 *   on a layer that needs it answers 503; it is never treated as "no layers"
 * - 5 failed evidence checks on one vault in 15 minutes lock that vault's
 *   evidence-bearing routes for 15 minutes
 * - audit lines and refusals never contain readings, IPs, identifiers, keys or
 *   credential material
 * - every challenge is bound to the Privy session it was issued to; a request
 *   whose session the server did not record is refused (503), never treated
 *   as "any session"
 * - a vault's first passkey applies at once only from the session that
 *   registered it, within ACTIVATION_WINDOW_MS (noteRegistration; the window
 *   is stored with the registration, so a restart keeps it); otherwise it is
 *   a 7-day recovery change, and nothing else can be enrolled first
 * - MFA is the vault's own authenticator (owner decision 2026-10-13; Privy MFA
 *   is never read): when it is on, a 6-digit RFC 6238 code is part of the
 *   evidence for the challenge, accepted within one 30-second step either side
 *   and only for a step after the last accepted one (single use). Its secret is
 *   stored sealed under ANTARA_VAULT_TOTP_KEY; without that key nothing that
 *   needs the authenticator is enrolled or approved (503)
 *
 * The guardian route (pairedVault.ts) calls authorizeRelease before the
 * guardian service may reserve or sign a vote; see docs/VAULT_LAYERS.md §7.
 * authorizeRelease grants the store's single-use release authorization, and
 * the server's stores refuse any reservation without one (vaultStore.ts), so
 * no other caller of the guardian service can skip the layers or the caps the
 * user set for the vault (the optional Limits layer; none by default).
 *
 * Owner decision 2026-10-13: adding to a layer, loosening it or turning it off
 * applies at once (loosening and turning off still need every layer that is
 * on). Only a recovery change, which waives a layer the user can no longer
 * satisfy, is pending (7 days, cancelable).
 */
import { createHash } from 'node:crypto';
import type { PrivyClient } from '@privy-io/node';
import { isSolanaAddress, parseTransactionIndex } from '../../../../src/solares/paired/solanaDecode';
import {
  GuardianError, VOTE_PENDING_MS, readGuardianConfig, readReleaseSnapshot, solanaJsonRpc, type SolanaClusterName, type SolanaRpc,
} from '../guardian.js';
import {
  effectiveReleaseLimits, evaluateRelease, privyUserFacts, rawCaps, usageInWindow,
  type OnchainSnapshot, type PrivyUserFacts, type ReleaseDecision, type VaultReleaseLimits,
} from '../vaultPolicy.js';
import { VaultStoreError, createVaultStore, vaultStoreOptions, vaultStorePath, type PairedVaultRecord, type VaultStore } from '../vaultStore.js';
import { createChallengeStore, type ChallengeStore, type LayerChallenge } from './challenges.js';
import { bytesEqual, hasOnlyKeys, isRecord, randomId, randomToken, toBase64Url, toHex } from './codec.js';
import { layerServerConfig, type LayerServerConfig } from './config.js';
import { BLUETOOTH_SOURCE, DeviceCheckError, GEO_SOURCE, importDeviceKey, keyIdOf, verifyDeviceEvidence, type DeviceKeyRecord } from './device.js';
import { changeDigest, releaseDigest, webauthnChallenge } from './digest.js';
import { LAYER_MESSAGES, LayerError, type LayerResult } from './errors.js';
import { validAccuracy, validLatLng } from './geo.js';
import { createLockout, type Lockout } from './lockout.js';
import { cidrFor, formatIp, maskCidr, observeNetwork, sameIp, type NetworkObservation, type NetworkSettings } from './network.js';
import { parseChangeOp, parseWaive } from './ops.js';
import { PasskeyCheckError, creationOptions, requestOptions, verifyAssertion, verifyRegistration, type VerifiedPasskey } from './passkey.js';
import { TOTP_CODE, base32Decode, generateTotpSecret, matchTotp, openTotpSecret, sealTotpSecret, totpKeyFromEnv } from './totp.js';
import {
  ChangeNotApplicableError, LAYER_FAILURES, PASSKEY_REQUIRED_MESSAGE, applyChange, checkDeviceBinding, describeLayers, effectiveConfig, emptyLayerConfig,
  enabledLayers, evaluateLayers, needsDeviceReading, planChange, requirementList, summariseChange,
  type ChangePlan, type DeviceOutcome, type DeviceView, type LayerView, type PasskeyOutcome, type PendingView, type TotpOutcome,
} from './policy.js';
import {
  ACTIVATION_WINDOW_MS, ENROLL_OP_TYPES, EVIDENCE_MAX_BYTES, HISTORY_LIMIT, RECOVERY_DELAY_MS, RELEASE_AUTHORIZATION_TTL_MS, RELEASE_RETRY_MS,
  type ActivationState, type AppliedChangeOp, type ChangeClass, type ChangeOp, type LayerId, type LayerRequirement, type LedgerLayerPass, type OptionalLayerId,
  type PendingChange, type Surface, type VaultLayerConfig,
} from './types.js';

export interface LayerRequestContext {
  /** clientIp(req) (../clientIp.ts: the edge header on Render, else req.ip behind exactly TRUST_PROXY hops); never taken from the request body. */
  ip: string | null | undefined;
  /**
   * The Privy session of the verified access token (verifyAccessToken().session_id, which Privy always
   * returns). null means authentication did not record it: every route that issues or uses a challenge refuses (503).
   */
  sessionId: string | null;
}
export interface LayerAuditEvent {
  action: 'approve' | 'enroll' | 'change' | 'cancel' | 'begin';
  outcome: 'allowed' | 'denied' | 'pending' | 'applied' | 'cancelled' | 'locked' | 'error';
  privyUserId: string;
  multisig: string;
  transactionIndex?: string;
  layers?: Array<{ id: LayerId; ok: boolean }>;
  class?: ChangeClass;
  /** ANTARA's own text; never a reading, address, identifier, key or token. */
  reason?: string;
}
export interface VaultLayerServiceDependencies {
  store: VaultStore;
  rpc: SolanaRpc;
  cluster: SolanaClusterName;
  /** G's address, as the guardian service pins it. */
  guardian: string;
  loadUser(privyUserId: string): Promise<PrivyUserFacts>;
  /** Passkey settings, read when a passkey is checked; an invalid value answers 503 and never disables the check. */
  passkeyConfig: () => LayerServerConfig;
  /**
   * The vault authenticator's sealing key (ANTARA_VAULT_TOTP_KEY), read when a secret is sealed or opened. Throws
   * GuardianError 503 when missing or invalid, which refuses the request; it never turns the MFA layer off.
   */
  totpKey?: () => Uint8Array;
  network: NetworkSettings;
  now?: () => number;
  /**
   * When this server process started (default: when this module loaded). An `already-registered` answer opens a
   * first-passkey window only for a registration made before it, whose own window a restart may have lost.
   */
  startedAt?: number;
  audit?: (event: LayerAuditEvent) => void;
  challenges?: ChallengeStore;
  lockout?: Lockout;
}

export interface LayersResponse {
  multisig: string;
  configVersion: number;
  serverTime: string;
  network: { observed: boolean; trusted: boolean | null };
  layers: LayerView[];
  devices: DeviceView[];
  pending: PendingView[];
}
interface ChallengeAnswer { challengeId: string; expiresAt: string; nonce: string; digest: string; configVersion: number; required: LayerRequirement[]; devices: Array<{ keyId: string; surface: Surface }> }
export interface ApprovalBeginResponse extends ChallengeAnswer {
  purpose: 'release';
  release: { multisig: string; transactionIndex: string; asset: 'SOL' | 'USDC'; amountRaw: string; recipient: string };
  webauthn: ReturnType<typeof requestOptions> | null;
}
export interface ChangeBeginResponse extends ChallengeAnswer {
  purpose: 'change';
  class: ChangeClass;
  /** null when the change applies immediately; otherwise when it would take effect if finished now. */
  effectiveAt: string | null;
  webauthn: { get: ReturnType<typeof requestOptions> | null; create: ReturnType<typeof creationOptions> | null };
  /**
   * Enroll routes only: the values the finish must capture. `totp.secret` (mfa.add) is the new authenticator's
   * base32 secret, shown once so the user can add it to an authenticator app; the finish must carry a code from it.
   */
  capture?: { geo?: true; wifi?: true; bluetooth?: 'choose'; network?: { observedCidr: string }; totp?: { secret: string } };
}
/** Tighten and loosen changes apply at once; only a recovery change is pending. */
export type ChangeFinishResponse =
  | { status: 'applied'; configVersion: number }
  | { status: 'pending'; change: { id: string; class: 'recovery'; effectiveAt: string } };
/** GET /limits?multisig=: the caps the user set for this vault (raw units; null = no cap) and what this vault released in the last 24 hours. */
export interface VaultLimitsResponse {
  multisig: string;
  limits: VaultReleaseLimits;
  usedLast24h: { SOL: string; USDC: string };
}
export type ReleaseAuthorization =
  | { kind: 'already-approved' }
  | { kind: 'pending'; signature: string }
  /** The store now holds a single-use release authorization for this proposal; the guardian service may reserve and sign. */
  | { kind: 'authorized'; request: { multisig: string; transactionIndex: string } };

export interface VaultLayerService {
  list(privyUserId: string, multisig: unknown, context: LayerRequestContext): Promise<LayersResponse>;
  /**
   * Opens the first-passkey window after the guardian answered a registration from this session: its first passkey
   * then applies at once only from this session, until ACTIVATION_WINDOW_MS after the registration (never later).
   * `registered` opens it; `already-registered` opens it only for a vault of this account registered within that
   * time, before this server process started (the registering session's own note may have been lost in a restart
   * or deploy), that has no passkey (none pending either) and no window recorded yet. A registration made by this
   * process is only ever opened by the session that registered it, so another session of the same account cannot
   * claim the window first. A recorded window is never moved to another session. Stored on the registration
   * (vaultStore.ts), so a restart keeps it. Without a session id nothing is opened. Never throws for an unknown vault.
   */
  noteRegistration(privyUserId: string, multisig: string, context: LayerRequestContext, status: 'registered' | 'already-registered'): Promise<void>;
  beginApproval(privyUserId: string, body: unknown, context: LayerRequestContext): Promise<ApprovalBeginResponse>;
  /**
   * The layer step of a guardian vote, run before the guardian service may
   * reserve or sign. Resolves only when the release may proceed (or needs no
   * new vote); throws GuardianError or LayerError otherwise. An `authorized`
   * answer grants the store's release authorization, which the guardian's
   * reservation consumes; the passed layers are recorded on that reservation.
   */
  authorizeRelease(privyUserId: string, body: unknown, context: LayerRequestContext): Promise<ReleaseAuthorization>;
  beginChange(privyUserId: string, body: unknown, route: 'enroll' | 'change', context: LayerRequestContext): Promise<ChangeBeginResponse>;
  finishChange(privyUserId: string, body: unknown, route: 'enroll' | 'change', context: LayerRequestContext): Promise<ChangeFinishResponse>;
  cancelChange(privyUserId: string, body: unknown, context: LayerRequestContext): Promise<{ status: 'cancelled'; configVersion: number }>;
  /** The caps the user set for one of their vaults (none by default) and that vault's releases in the last 24 hours. Read-only. */
  limits(privyUserId: string, multisig: unknown): Promise<VaultLimitsResponse>;
}

const invalid = (message: string) => new GuardianError(message, 400, 'invalid');
const unavailable = (message: string) => new GuardianError(message, 503, 'unavailable');
const conflict = (message: string) => new GuardianError(message, 409, 'conflict');
const iso = (at: number) => new Date(at).toISOString();
const CHALLENGE_ID = /^[A-Za-z0-9_-]{22}$/;
const CHANGE_ID = /^chg_[A-Za-z0-9_-]{16}$/;
const NETWORK_UNOBSERVABLE = 'ANTARA cannot see the public internet address of this request on this server, so the Wi-Fi layer cannot be checked. Nothing was approved or changed.';
const SESSION_UNBOUND = 'ANTARA could not bind this request to your sign-in session on this server, so vault protection cannot be checked. Nothing was approved or changed.';
/** What the store keeps of the session a first-passkey window is bound to: a domain-separated SHA-256, never the session id. */
export const activationSessionHash = (sessionId: string) => createHash('sha256').update(`antara-first-passkey:${sessionId}`).digest('hex');
/** When this module loaded: the server process's start, for noteRegistration. */
const PROCESS_STARTED_AT = Date.now();
const defaultAudit = (event: LayerAuditEvent) => console.info(JSON.stringify({ event: 'antara.guardian.layers', at: new Date().toISOString(), ...event }));

function storeError(error: unknown): GuardianError {
  if (error instanceof GuardianError) return error;
  if (error instanceof VaultStoreError && error.code === 'conflict') return conflict(error.message);
  if (error instanceof VaultStoreError) console.error(JSON.stringify({ event: 'antara.guardian.store', at: new Date().toISOString(), code: error.code, error: error.message }));
  return unavailable('Vault storage is unavailable. Nothing was approved or changed.');
}
function readStore<T>(work: () => T): T {
  try { return work(); } catch (error) { throw storeError(error); }
}
const policyError = (decision: { reason: string; status: 403 | 409 | 503 }) =>
  new GuardianError(decision.reason, decision.status, decision.status === 403 ? 'denied' : decision.status === 409 ? 'conflict' : 'unavailable');
const passkeyRequired = () => new LayerError(PASSKEY_REQUIRED_MESSAGE, 403, 'layer-failed', { layers: [{ id: 'biometrics', ok: false, reason: PASSKEY_REQUIRED_MESSAGE }] });

function parseMultisig(value: unknown): string {
  if (!isSolanaAddress(value)) throw invalid('Invalid vault address.');
  return value;
}
function parseIndex(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw invalid('Invalid proposal index.');
  try { parseTransactionIndex(value); } catch { throw invalid('Invalid proposal index.'); }
  return value;
}
/** The routes refuse evidence over 16 KB, inside the 256 KB body limit. */
function assertEvidenceSize(value: unknown) {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); } catch { throw invalid('The verification evidence is malformed.'); }
  if (size > EVIDENCE_MAX_BYTES) throw invalid('The verification evidence is too large.');
}
interface ParsedEvidence { challengeId: string; passkey?: unknown; registration?: unknown; device?: unknown; totp?: { code: string } }
function parseEvidence(value: unknown, allowRegistration: boolean): ParsedEvidence {
  if (!hasOnlyKeys(value, ['challengeId'], allowRegistration ? ['passkey', 'device', 'registration', 'totp'] : ['passkey', 'device', 'totp']) ||
    typeof value.challengeId !== 'string' || !CHALLENGE_ID.test(value.challengeId)) throw invalid('The verification evidence is malformed.');
  for (const key of ['passkey', 'device', 'registration', 'totp'] as const) if (key in value && !isRecord(value[key])) throw invalid('The verification evidence is malformed.');
  // The authenticator code: exactly six digits, nothing else.
  if ('totp' in value && (!hasOnlyKeys(value.totp, ['code']) || typeof value.totp.code !== 'string' || !TOTP_CODE.test(value.totp.code))) {
    throw invalid('The authenticator code must be 6 digits.');
  }
  return value as unknown as ParsedEvidence;
}
const layerResults = (layers: readonly LayerResult[]) => layers.map(({ id, ok }) => ({ id, ok }));
/** The SSID as text for display (lossy, control characters replaced); matching always uses the raw bytes (ssidHex). */
const ssidText = (ssidHex: string) => Buffer.from(ssidHex, 'hex').toString('utf8').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?').slice(0, 64);

export function createVaultLayerService(deps: VaultLayerServiceDependencies): VaultLayerService {
  const now = deps.now ?? Date.now;
  const startedAt = deps.startedAt ?? PROCESS_STARTED_AT;
  const audit = deps.audit ?? defaultAudit;
  const challenges = deps.challenges ?? createChallengeStore({ now });
  const lockout = deps.lockout ?? createLockout({ now });
  const store = deps.store;
  // First-passkey windows are stored on the vault's registration (vaultStore.ts `activation`), so a restart or deploy
  // between registering and adding the passkey does not turn that passkey into a 7-day recovery change.

  /** Every challenge is bound to a session: a request whose session id authentication did not record is refused, never matched as "no session". */
  const requireSession = (context: LayerRequestContext): string => {
    if (typeof context.sessionId !== 'string' || !context.sessionId) throw unavailable(SESSION_UNBOUND);
    return context.sessionId;
  };
  /** The first-passkey window for this request (ActivationState), as recorded on the registration. */
  const activationFor = (privyUserId: string, registration: PairedVaultRecord, sessionId: string, at: number): ActivationState => {
    const grant = registration.activation;
    const registeredAt = Date.parse(registration.createdAt);
    const until = grant ? Date.parse(grant.expiresAt) : NaN;
    if (!grant || grant.privyUserId !== privyUserId || registration.privyUserId !== privyUserId || !(until > at) || !Number.isFinite(registeredAt) ||
      at - registeredAt >= ACTIVATION_WINDOW_MS) return 'none';
    return grant.sessionHash === activationSessionHash(sessionId) ? 'session' : 'other-session';
  };

  const loadUser = async (privyUserId: string) => {
    let user: PrivyUserFacts;
    try { user = await deps.loadUser(privyUserId); } catch { throw unavailable('Your account could not be verified with Privy. Retry shortly.'); }
    if (!user || user.id !== privyUserId) throw unavailable('Your account could not be verified with Privy. Retry shortly.');
    return user;
  };
  /** The caller's own registered vault; counted toward nothing until ownership is proven. */
  const owned = async (privyUserId: string, multisig: string, action: LayerAuditEvent['action'] | null, transactionIndex?: string) => {
    const user = await loadUser(privyUserId);
    const registration = readStore(() => store.getVault(multisig));
    if (!registration) throw conflict('This vault is not registered with ANTARA. Activate it again.');
    if (registration.privyUserId !== user.id) {
      if (action) audit({ action, outcome: 'denied', privyUserId, multisig, ...(transactionIndex ? { transactionIndex } : {}), reason: 'vault registered to another account' });
      throw new GuardianError('This vault belongs to another account.', 403, 'denied');
    }
    return { user, registration };
  };
  const assertUnlocked = (privyUserId: string, multisig: string, action: LayerAuditEvent['action'], transactionIndex?: string) => {
    const state = lockout.check(multisig);
    if (!state.locked) return;
    audit({ action, outcome: 'locked', privyUserId, multisig, ...(transactionIndex ? { transactionIndex } : {}), reason: 'too many failed protection checks' });
    throw new LayerError(LAYER_MESSAGES.locked, 429, 'locked', {}, state.retryAfterSeconds);
  };
  /** Records a failed evidence check (lockout and audit) and returns the error to throw. */
  const failure = (error: LayerError, event: LayerAuditEvent): LayerError => {
    const state = lockout.fail(event.multisig);
    audit({ ...event, outcome: state.locked ? 'locked' : 'denied' });
    return error;
  };
  const current = (multisig: string, at: number) => {
    const stored = readStore(() => store.layerConfig(multisig));
    if (!stored) return { stored: null, config: null };
    try { return { stored, config: effectiveConfig(stored, at).config }; }
    catch { throw unavailable('Vault protection layers could not be read. Nothing was approved or changed.'); }
  };
  /** The caps the user set for this vault through the Limits layer; none when the layer is off. */
  const limitsFor = (config: VaultLayerConfig | null) => {
    try { return effectiveReleaseLimits(config?.limits ?? null); }
    catch { throw unavailable('Vault limits are misconfigured. Nothing was approved or changed.'); }
  };
  const passkeySettings = () => {
    try { return deps.passkeyConfig(); }
    catch (error) { throw error instanceof GuardianError ? error : unavailable('Passkeys cannot be checked on this server. Nothing was approved or changed.'); }
  };
  const totpKey = () => {
    try { return (deps.totpKey ?? (() => totpKeyFromEnv(process.env)))(); }
    catch (error) { throw error instanceof GuardianError ? error : unavailable('Vault authenticator codes cannot be checked on this server. Nothing was approved or changed.'); }
  };
  /** Checks a code against the vault's stored authenticator. Replay (a step already used) is refused inside the store lock (withTotpStep). */
  const verifyTotp = (evidence: { code: string } | undefined, config: VaultLayerConfig | null, multisig: string, at: number): TotpOutcome => {
    if (!config?.mfa) return null;
    if (evidence === undefined) return { ok: false, reason: LAYER_FAILURES.totpMissing };
    // A missing or wrong sealing key is the server's fault: 503, never a pass and never counted against the user.
    const key = totpKey();
    let secret: Uint8Array;
    try { secret = openTotpSecret(config.mfa.secret, key, multisig); }
    catch { throw unavailable('The vault authenticator could not be read on this server. Nothing was approved or changed.'); }
    const step = matchTotp(secret, evidence.code, at);
    return step === null ? { ok: false, reason: LAYER_FAILURES.totp } : { ok: true, step };
  };
  /** Records the accepted step on the authenticator; a step at or before the last accepted one is a replay (null). */
  const withTotpStep = (config: VaultLayerConfig, totp: TotpOutcome): VaultLayerConfig | null => {
    if (!totp?.ok) return config;
    if (!config.mfa || totp.step <= config.mfa.lastStep) return null;
    const next = structuredClone(config);
    next.mfa!.lastStep = totp.step;
    return next;
  };
  const observe = (context: LayerRequestContext): NetworkObservation => observeNetwork(context.ip, deps.network);
  const requireObservableNetwork = (required: readonly OptionalLayerId[], network: NetworkObservation) => {
    if (required.includes('wifi') && network.status === 'unconfigured') throw unavailable(NETWORK_UNOBSERVABLE);
  };
  const ipText = (network: NetworkObservation) => network.status === 'public' ? formatIp(network.ip) : null;
  const deviceList = (config: VaultLayerConfig | null) => (config?.devices ?? []).map(({ keyId, surface }) => ({ keyId, surface }));
  const challengeAnswer = (challenge: LayerChallenge, required: LayerRequirement[], config: VaultLayerConfig | null): ChallengeAnswer => ({
    challengeId: challenge.id, expiresAt: iso(challenge.expiresAt), nonce: toBase64Url(challenge.nonce), digest: toHex(challenge.digest),
    configVersion: challenge.configVersion, required, devices: deviceList(config),
  });

  const verifyPasskey = async (response: unknown, config: VaultLayerConfig | null, challenge: LayerChallenge): Promise<PasskeyOutcome> => {
    if (response === undefined) return null;
    const settings = passkeySettings();
    try {
      const facts = await verifyAssertion({
        response, credentials: config?.biometrics?.credentials ?? [], expectedChallenge: webauthnChallenge('get', challenge.nonce, challenge.digest), config: settings,
      });
      return { ok: true, facts };
    } catch (error) {
      if (error instanceof PasskeyCheckError) return { ok: false, reason: error.message };
      return { ok: false, reason: LAYER_FAILURES.passkey };
    }
  };
  const verifyDevice = (evidence: unknown, key: DeviceKeyRecord | null): DeviceOutcome => {
    if (evidence === undefined) return null;
    if (!key) return { ok: false, reason: LAYER_FAILURES.untrustedDevice };
    try { return { ok: true, payload: verifyDeviceEvidence(evidence, key), key }; }
    catch (error) { return { ok: false, reason: error instanceof DeviceCheckError ? error.message : LAYER_FAILURES.unchecked }; }
  };
  const trustedKey = (evidence: unknown, config: VaultLayerConfig | null): DeviceKeyRecord | null => {
    const keyId = (evidence as { keyId?: unknown } | undefined)?.keyId;
    const device = config?.devices.find(item => item.keyId === keyId);
    return device ? { keyId: device.keyId, publicKeySpki: device.publicKeySpki, surface: device.surface } : null;
  };
  /** Stores the assertion's counter on the credential; a counter that did not advance since verification is a clone or replay. */
  const withCounter = (config: VaultLayerConfig, passkey: PasskeyOutcome): VaultLayerConfig | null => {
    if (!passkey?.ok) return config;
    const next = structuredClone(config);
    const credential = next.biometrics?.credentials.find(item => item.id === passkey.facts.credentialId);
    if (!credential) return null;
    if ((passkey.facts.newCounter > 0 || credential.counter > 0) && passkey.facts.newCounter <= credential.counter) return null;
    credential.counter = passkey.facts.newCounter;
    return next;
  };
  const write = (multisig: string, stored: VaultLayerConfig | null, next: VaultLayerConfig) => readStore(() => store.writeLayerConfig(multisig, stored?.version ?? null, next));

  // ---------------------------------------------------------------- releases
  const parseRelease = (body: unknown, withLayers: boolean) => {
    if (!hasOnlyKeys(body, ['multisig', 'transactionIndex'], withLayers ? ['layers'] : [])) {
      if (!isRecord(body) || !isSolanaAddress(body.multisig)) throw invalid('Invalid vault address.');
      if (!('transactionIndex' in body)) throw invalid('Invalid proposal index.');
      throw invalid('The release request has unexpected fields.');
    }
    const request = { multisig: parseMultisig(body.multisig), transactionIndex: parseIndex(body.transactionIndex) };
    let layers: ParsedEvidence | null = null;
    if (withLayers && body.layers !== undefined) {
      assertEvidenceSize(body.layers);
      layers = parseEvidence(body.layers, false);
    }
    return { request, layers };
  };
  const snapshot = async (request: { multisig: string; transactionIndex: string }): Promise<OnchainSnapshot> => {
    try { return await readReleaseSnapshot(deps.rpc, deps.cluster, request, now); }
    catch { throw unavailable('The vault could not be read from the Solana network. Try again.'); }
  };
  const decide = (user: PrivyUserFacts, registration: PairedVaultRecord, request: { multisig: string; transactionIndex: string }, onchain: OnchainSnapshot, config: VaultLayerConfig | null, at: number): ReleaseDecision =>
    evaluateRelease({ user, guardian: deps.guardian, registration, request, onchain, limits: limitsFor(config), ledger: () => store.ledger(), now: at });
  const digestFor = (registration: PairedVaultRecord, request: { multisig: string; transactionIndex: string }, onchain: OnchainSnapshot, decision: Extract<ReleaseDecision, { allow: true }>) => {
    const data = onchain.transaction?.data;
    if (!data) throw unavailable('The vault transaction could not be read. Try again.');
    return releaseDigest({
      cluster: deps.cluster, multisig: request.multisig, vault: registration.vault, transactionIndex: request.transactionIndex, transactionData: data,
      asset: decision.intent.asset, amountRaw: decision.intent.amountRaw.toString(), recipient: decision.intent.recipient, destination: decision.intent.destination,
    });
  };
  const challengeFits = (challenge: LayerChallenge | null, expected: { privyUserId: string; sessionId: string | null; multisig: string; purpose: 'release' | 'change'; transactionIndex?: string }) =>
    !!challenge && challenge.privyUserId === expected.privyUserId && challenge.sessionId === expected.sessionId && challenge.multisig === expected.multisig &&
    challenge.purpose === expected.purpose && challenge.transactionIndex === expected.transactionIndex;

  // ----------------------------------------------------------------- changes
  const parseBegin = (body: unknown, route: 'enroll' | 'change') => {
    if (!hasOnlyKeys(body, ['multisig', 'op'], ['waive'])) throw invalid('The protection change request is malformed.');
    return { multisig: parseMultisig(body.multisig), op: parseChangeOp(body.op, route), waived: parseWaive(body.waive) };
  };
  const parseFinish = (body: unknown, route: 'enroll' | 'change') => {
    if (!hasOnlyKeys(body, ['multisig', 'challengeId'], route === 'enroll' ? ['registration', 'passkey', 'device', 'totp'] : ['passkey', 'device', 'totp'])) {
      throw invalid('The protection change request is malformed.');
    }
    const multisig = parseMultisig(body.multisig);
    const evidence = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'multisig'));
    assertEvidenceSize(evidence);
    return { multisig, evidence: parseEvidence(evidence, route === 'enroll') };
  };
  const plan = (config: VaultLayerConfig | null, op: ChangeOp, waived: OptionalLayerId[], activation: ActivationState): ChangePlan => {
    // A stored Limits value that cannot be read must never be treated as "no limits" (503).
    limitsFor(config);
    return planChange({ config, op, waived, activation });
  };
  /** The store's release authorization for this proposal, with the vault's own caps (if any) and the stored layer version it was granted at. */
  const grantRelease = (privyUserId: string, request: { multisig: string; transactionIndex: string }, config: VaultLayerConfig | null, layerVersion: number | null, pass: LedgerLayerPass | null, at: number) => {
    const limits = rawCaps(limitsFor(config));
    readStore(() => store.authorizeRelease(request.multisig, request.transactionIndex, {
      privyUserId, pass, limits, layerVersion, expiresAt: at + RELEASE_AUTHORIZATION_TTL_MS,
    }));
  };

  const readingLayer = (op: ChangeOp): LayerId => op.type.startsWith('geolocation') ? 'geolocation' : op.type.startsWith('wifi') ? 'wifi' : op.type.startsWith('bluetooth') ? 'bluetooth' : 'biometrics';
  const captures = (op: ChangeOp) => op.type === 'device.add' || op.type === 'wifi.add-radio' || op.type === 'wifi.add-bssid' || op.type === 'bluetooth.add-device' ||
    (op.type === 'geolocation.add-zone' && op.center === 'current');
  /** Builds the change as stored, with the values captured at finish. Throws GuardianError (400/409) for an unusable capture. */
  const captureOp = (input: {
    op: ChangeOp; config: VaultLayerConfig | null; at: number; challenge: LayerChallenge; registration: VerifiedPasskey | null;
    device: DeviceOutcome; network: NetworkObservation; newTotp: { secret: string; step: number } | null;
  }): AppliedChangeOp => {
    const { op, config, at, challenge } = input;
    const addedAt = iso(at);
    const reading = () => {
      const bound = checkDeviceBinding(input.device, challenge, at);
      if (!bound.ok) throw new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: [{ id: readingLayer(op), ok: false, reason: bound.reason }] });
      return bound;
    };
    switch (op.type) {
      case 'passkey.add': {
        const credential = input.registration;
        if (!credential) throw invalid('The new passkey is missing.');
        const known = new Set([...(config?.biometrics?.credentials ?? []).map(item => item.id),
          ...(config?.pending ?? []).flatMap(change => change.op.type === 'passkey.add' ? [change.op.credential.id] : [])]);
        if (known.has(credential.id)) throw conflict('This passkey is already enrolled for this vault.');
        return { type: op.type, credential: { ...credential, label: op.label, addedAt } };
      }
      case 'device.add': {
        const bound = reading();
        if (bound.surface !== op.surface) throw invalid('The device proof came from a different app.');
        const { spki } = importDeviceKey(op.publicKeySpki);
        return { type: op.type, device: { keyId: keyIdOf(spki), publicKeySpki: op.publicKeySpki, surface: op.surface, label: op.label, addedAt } };
      }
      case 'geolocation.add-zone': {
        if (op.center !== 'current') return { type: op.type, zone: { id: randomId('zone'), label: op.label, lat: op.center.lat, lng: op.center.lng, radiusM: op.radiusM, addedAt } };
        const bound = reading();
        const geo = bound.payload.geo;
        if (!geo || geo.source !== GEO_SOURCE[bound.surface] || !validLatLng(geo.lat, geo.lng) || !validAccuracy(geo.accuracyM)) {
          throw conflict('A usable location reading is needed to add this place.');
        }
        if (geo.accuracyM > op.radiusM / 2) throw conflict('Your location reading is not accurate enough for a safe zone of this size. Use a larger radius or try again.');
        return { type: op.type, zone: { id: randomId('zone'), label: op.label, lat: geo.lat, lng: geo.lng, radiusM: op.radiusM, addedAt } };
      }
      case 'wifi.add-network': {
        if (op.cidr) return { type: op.type, network: { id: randomId('net'), label: op.label, cidr: op.cidr, addedAt } };
        const network = input.network;
        if (network.status === 'unconfigured') throw unavailable(NETWORK_UNOBSERVABLE);
        if (network.status !== 'public') throw conflict('ANTARA cannot see a public internet address for this request, so this network cannot be trusted.');
        const begun = challenge.ip === null ? null : observeNetwork(challenge.ip, { production: false, trustProxy: false });
        if (!begun || begun.status !== 'public' || !sameIp(begun.ip, network.ip)) throw conflict('Your network changed while adding it. Start again.');
        const cidr = cidrFor(network.ip, op.prefixLength);
        if (!cidr) throw invalid('That prefix length does not fit this network (IPv4 /24 to /32, IPv6 /48 to /128).');
        return { type: op.type, network: { id: randomId('net'), label: op.label, cidr, addedAt } };
      }
      case 'wifi.add-radio': {
        const bound = reading();
        if (bound.surface !== 'desktop') throw conflict("Wi-Fi names can only be added from ANTARA Desktop.");
        const wifi = bound.payload.wifi;
        const enrolled = new Set((config?.wifi?.radios ?? []).map(radio => radio.ssidHex));
        const fresh = (wifi?.connections ?? []).filter(connection => !enrolled.has(connection.ssidHex));
        if (!wifi || fresh.length !== 1) throw conflict('Connect this computer to exactly one Wi-Fi network that is not trusted yet.');
        const [connection] = fresh;
        return { type: op.type, radio: { id: randomId('radio'), label: op.label, ssid: ssidText(connection.ssidHex), ssidHex: connection.ssidHex, bssids: [connection.bssid], addedAt } };
      }
      case 'wifi.add-bssid': {
        const bound = reading();
        if (bound.surface !== 'desktop') throw conflict('Access points can only be added from ANTARA Desktop.');
        const radio = config?.wifi?.radios.find(item => item.id === op.radioId);
        if (!radio) throw conflict('That Wi-Fi name is not active on this vault.');
        const fresh = [...new Set((bound.payload.wifi?.connections ?? []).filter(connection => connection.ssidHex === radio.ssidHex && !radio.bssids.includes(connection.bssid)).map(item => item.bssid))];
        if (fresh.length !== 1) throw conflict('Connect this computer to a new access point of this Wi-Fi network.');
        return { type: op.type, radioId: radio.id, bssid: fresh[0] };
      }
      case 'bluetooth.add-device': {
        const bound = reading();
        const source = BLUETOOTH_SOURCE[bound.surface];
        const bluetooth = bound.payload.bluetooth;
        if (!bluetooth || bluetooth.source !== source) throw conflict('Choose the Bluetooth device to trust.');
        const enrolled = new Set((config?.bluetooth?.devices ?? []).filter(item => item.surface === bound.surface && item.source === source).map(item => item.identifier));
        const fresh = bluetooth.devices.filter(item => !enrolled.has(item.identifier));
        if (fresh.length !== 1) throw conflict('Choose exactly one Bluetooth device that is not trusted yet.');
        const [device] = fresh;
        return { type: op.type, device: { id: randomId('bt'), label: op.label, surface: bound.surface, source, identifier: device.identifier, name: device.name, addedAt } };
      }
      case 'mfa.add': {
        const fresh = input.newTotp;
        if (!fresh) throw invalid('The authenticator code is missing.');
        // Sealed before it is stored; the enrollment code's step is already used.
        return { type: op.type, authenticator: { id: randomId('totp'), label: op.label, secret: sealTotpSecret(fresh.secret, totpKey(), challenge.multisig), lastStep: fresh.step, addedAt } };
      }
      case 'passkey.remove': case 'device.remove': case 'geolocation.remove-zone': case 'wifi.remove-network': case 'wifi.remove-radio':
      case 'wifi.set-mode': case 'bluetooth.remove-device': case 'limits.set': case 'layer.disable':
        return structuredClone(op);
    }
  };

  return {
    async list(privyUserId, multisigValue, context) {
      const multisig = parseMultisig(multisigValue);
      await owned(privyUserId, multisig, null);
      const at = now();
      const { config } = current(multisig, at);
      limitsFor(config);
      const view = describeLayers({ config, network: observe(context) });
      return { multisig, configVersion: view.configVersion, serverTime: iso(at), network: view.network, layers: view.layers, devices: view.devices, pending: view.pending };
    },

    async noteRegistration(privyUserId, multisig, context, status) {
      if (typeof context.sessionId !== 'string' || !context.sessionId || !isSolanaAddress(multisig)) return;
      if (status !== 'registered' && status !== 'already-registered') return;
      const sessionHash = activationSessionHash(context.sessionId);
      await store.withLock(() => {
        const registration = readStore(() => store.getVault(multisig));
        const registeredAt = registration ? Date.parse(registration.createdAt) : NaN;
        if (!registration || registration.privyUserId !== privyUserId || !Number.isFinite(registeredAt)) return;
        // Set once: an open (or expired) window is never re-bound to the session that asks next.
        if (registration.activation) return;
        // Registered by this process: only the registering session's own note (`registered`) opens the window.
        if (status === 'already-registered' && !(registeredAt < startedAt)) return;
        const at = now();
        const until = registeredAt + ACTIVATION_WINDOW_MS;
        if (!(at < until)) return;
        // Only a vault without a passkey, in force or pending (a recovery one), has a first passkey to add.
        const { stored, config } = current(multisig, at);
        if (config?.biometrics || stored?.pending.some(change => change.op.type === 'passkey.add')) return;
        readStore(() => store.openActivation(multisig, { privyUserId, sessionHash, openedAt: iso(at), expiresAt: iso(until) }));
      });
    },

    async beginApproval(privyUserId, body, context) {
      const { request } = parseRelease(body, false);
      requireSession(context);
      const { user, registration } = await owned(privyUserId, request.multisig, 'begin', request.transactionIndex);
      assertUnlocked(privyUserId, request.multisig, 'begin', request.transactionIndex);
      const onchain = await snapshot(request);
      const at = now();
      const { config } = current(request.multisig, at);
      if (!config?.biometrics) {
        audit({ action: 'begin', outcome: 'denied', privyUserId, ...request, reason: 'no passkey enrolled' });
        throw passkeyRequired();
      }
      const decision = decide(user, registration, request, onchain, config, at);
      if (!decision.allow) {
        if (decision.alreadyApproved) throw conflict('The ANTARA guardian has already approved this release.');
        audit({ action: 'begin', outcome: 'denied', privyUserId, ...request, reason: decision.reason });
        throw policyError(decision);
      }
      const required = enabledLayers(config);
      const settings = passkeySettings();
      // A code that could not be checked must not be asked for: without the sealing key the begin fails (503).
      if (required.includes('mfa')) totpKey();
      const network = observe(context);
      requireObservableNetwork(required, network);
      const digest = digestFor(registration, request, onchain, decision);
      const challenge = challenges.issue({
        privyUserId, sessionId: context.sessionId, multisig: request.multisig, purpose: 'release', transactionIndex: request.transactionIndex,
        digest, configVersion: config.version, required, ip: ipText(network),
      });
      audit({ action: 'begin', outcome: 'allowed', privyUserId, ...request });
      return {
        ...challengeAnswer(challenge, requirementList(config, required, true, challenge.nonce), config),
        purpose: 'release',
        release: { multisig: request.multisig, transactionIndex: request.transactionIndex, asset: decision.intent.asset, amountRaw: decision.intent.amountRaw.toString(), recipient: decision.intent.recipient },
        webauthn: requestOptions(settings, config.biometrics.credentials, webauthnChallenge('get', challenge.nonce, challenge.digest)),
      };
    },

    async authorizeRelease(privyUserId, body, context) {
      const { request, layers } = parseRelease(body, true);
      requireSession(context);
      const { user, registration } = await owned(privyUserId, request.multisig, 'approve', request.transactionIndex);
      if (layers) assertUnlocked(privyUserId, request.multisig, 'approve', request.transactionIndex);
      const onchain = await snapshot(request);
      // Single use even when a later step fails.
      const challenge = layers ? challenges.take(layers.challengeId) : null;
      const expected = { privyUserId, sessionId: context.sessionId, multisig: request.multisig, purpose: 'release' as const, transactionIndex: request.transactionIndex };
      const fits = challengeFits(challenge, expected);
      // Asynchronous crypto outside the store lock, against the configuration in force now.
      let passkey: PasskeyOutcome = null, device: DeviceOutcome = null, totp: TotpOutcome = null;
      if (layers && fits && challenge) {
        const { config } = current(request.multisig, now());
        passkey = await verifyPasskey(layers.passkey, config, challenge);
        device = verifyDevice(layers.device, trustedKey(layers.device, config));
        if (challenge.required.includes('mfa')) totp = verifyTotp(layers.totp, config, request.multisig, now());
      }
      return store.withLock((): ReleaseAuthorization => {
        const at = now();
        const { stored, config } = current(request.multisig, at);
        const decision = decide(user, registration, request, onchain, config, at);
        if (!decision.allow) {
          if (decision.alreadyApproved) return { kind: 'already-approved' };
          audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: decision.reason });
          throw policyError(decision);
        }
        const existing = readStore(() => store.ledgerEntry(request.multisig, request.transactionIndex));
        // A vote that may still land is answered, never paid for twice; no new evidence is needed for that answer.
        if (existing?.signature && existing.signedAt && at - Date.parse(existing.signedAt) < VOTE_PENDING_MS) return { kind: 'pending', signature: existing.signature };
        if (!config?.biometrics) {
          audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: 'no passkey enrolled' });
          throw passkeyRequired();
        }
        // Retry after a Privy signing failure: this exact reservation passed at the current configuration within 30 minutes.
        const passed = existing?.layers;
        if (passed && existing.privyUserId === user.id && passed.configVersion === config.version) {
          const age = at - Date.parse(passed.passedAt);
          if (age >= 0 && age < RELEASE_RETRY_MS) {
            grantRelease(user.id, request, config, stored?.version ?? null, null, at);
            return { kind: 'authorized', request };
          }
        }
        const required = enabledLayers(config);
        if (!layers) {
          audit({ action: 'approve', outcome: 'denied', privyUserId, ...request, reason: 'protection layers required' });
          // No challenge here, so Desktop Bluetooth devices are not listed (requirementList); the begin answer lists them.
          throw new LayerError(LAYER_MESSAGES.required, 403, 'layers-required', { required: requirementList(config, required, true, null) });
        }
        const event = { action: 'approve' as const, outcome: 'denied' as const, privyUserId, ...request };
        if (!challenge || !fits) throw failure(new LayerError(LAYER_MESSAGES.invalid, 403, 'challenge-invalid'), { ...event, reason: 'challenge invalid' });
        if (challenge.configVersion !== config.version || !bytesEqual(digestFor(registration, request, onchain, decision), challenge.digest)) {
          audit({ ...event, reason: 'challenge stale' });
          throw new LayerError(LAYER_MESSAGES.stale, 409, 'challenge-stale');
        }
        const network = observe(context);
        requireObservableNetwork(challenge.required, network);
        const result = evaluateLayers({ config, required: challenge.required, challenge, passkey, device, totp, network, now: at });
        const counted = result.ok ? withCounter(config, passkey) : null;
        const next = counted ? withTotpStep(counted, totp) : null;
        if (!result.ok || !next) {
          // A passkey counter that did not advance, or an authenticator step already used (a replayed code), fails that layer.
          const results = result.ok ? result.layers.map(layer => layer.id === 'biometrics' && !counted ? { id: layer.id, ok: false, reason: LAYER_FAILURES.passkey }
            : layer.id === 'mfa' && counted && !next ? { id: layer.id, ok: false, reason: LAYER_FAILURES.totp } : layer) : result.layers;
          throw failure(new LayerError(LAYER_MESSAGES.failed, 403, 'layer-failed', { layers: results }), { ...event, layers: layerResults(results), reason: 'protection layer failed' });
        }
        const layerVersion = stored && (passkey?.ok || totp?.ok || stored.version !== config.version) ? write(request.multisig, stored, next).version : stored?.version ?? null;
        // The guardian's reservation consumes this grant and records the layers that passed on it.
        grantRelease(user.id, request, config, layerVersion, { challengeId: challenge.id, configVersion: config.version, passedAt: iso(at), enforced: result.enforced }, at);
        audit({ action: 'approve', outcome: 'allowed', privyUserId, ...request, layers: layerResults(result.layers) });
        return { kind: 'authorized', request };
      });
    },

    async beginChange(privyUserId, body, route, context) {
      const { multisig, op, waived: requested } = parseBegin(body, route);
      const sessionId = requireSession(context);
      const action: LayerAuditEvent['action'] = route === 'enroll' ? 'enroll' : 'change';
      const { registration } = await owned(privyUserId, multisig, action);
      assertUnlocked(privyUserId, multisig, action);
      const at = now();
      const { config } = current(multisig, at);
      const changePlan = plan(config, op, requested, activationFor(privyUserId, registration, sessionId, at));
      const waived = changePlan.waived;
      const network = observe(context);
      requireObservableNetwork(changePlan.required, network);
      const needsPasskey = changePlan.required.includes('biometrics') || op.type === 'passkey.add';
      const settings = needsPasskey ? passkeySettings() : null;
      // The authenticator secret is sealed at finish and opened for every check, so nothing that needs it starts without the key.
      if (changePlan.required.includes('mfa') || changePlan.capture.totp) totpKey();
      const totpSecret = changePlan.capture.totp ? generateTotpSecret() : undefined;
      let observedCidr: string | null = null;
      if (changePlan.capture.network) {
        if (network.status === 'unconfigured') throw unavailable(NETWORK_UNOBSERVABLE);
        if (network.status !== 'public') throw conflict('ANTARA cannot see a public internet address for this request, so this network cannot be trusted.');
        const cidr = cidrFor(network.ip, op.type === 'wifi.add-network' ? op.prefixLength : undefined);
        if (!cidr) throw invalid('That prefix length does not fit this network (IPv4 /24 to /32, IPv6 /48 to /128).');
        observedCidr = cidr;
      }
      const configVersion = config?.version ?? 0;
      const webauthnUserId = config?.webauthnUserId ?? randomToken(32);
      const digest = changeDigest({ multisig, configVersion, op, waived });
      const challenge = challenges.issue({
        privyUserId, sessionId, multisig, purpose: 'change', op, waived, class: changePlan.class, webauthnUserId,
        digest, configVersion, required: changePlan.required, ip: ipText(network), ...(totpSecret ? { totpSecret } : {}),
      });
      audit({ action: 'begin', outcome: 'allowed', privyUserId, multisig, class: changePlan.class });
      const getChallenge = webauthnChallenge('get', challenge.nonce, challenge.digest);
      const response: ChangeBeginResponse = {
        ...challengeAnswer(challenge, requirementList(config, changePlan.required, false, challenge.nonce), config),
        purpose: 'change',
        class: changePlan.class,
        effectiveAt: changePlan.delayMs === null ? null : iso(at + changePlan.delayMs),
        webauthn: {
          get: settings && changePlan.required.includes('biometrics') ? requestOptions(settings, config?.biometrics?.credentials ?? [], getChallenge) : null,
          create: settings && op.type === 'passkey.add' ? creationOptions({
            config: settings, webauthnUserId, multisig, challenge: webauthnChallenge('create', challenge.nonce, challenge.digest),
            exclude: [...(config?.biometrics?.credentials ?? []), ...(config?.pending ?? []).flatMap(change => change.op.type === 'passkey.add' ? [change.op.credential] : [])],
          }) : null,
        },
      };
      if (route === 'enroll') {
        response.capture = {
          ...(changePlan.capture.geo ? { geo: true as const } : {}),
          ...(changePlan.capture.wifi ? { wifi: true as const } : {}),
          ...(changePlan.capture.bluetooth ? { bluetooth: 'choose' as const } : {}),
          ...(observedCidr ? { network: { observedCidr: maskCidr(observedCidr) } } : {}),
          ...(totpSecret ? { totp: { secret: totpSecret } } : {}),
        };
      }
      return response;
    },

    async finishChange(privyUserId, body, route, context) {
      const { multisig, evidence } = parseFinish(body, route);
      const sessionId = requireSession(context);
      const action: LayerAuditEvent['action'] = route === 'enroll' ? 'enroll' : 'change';
      const { registration: vault } = await owned(privyUserId, multisig, action);
      assertUnlocked(privyUserId, multisig, action);
      const challenge = challenges.take(evidence.challengeId);
      const event = { action, outcome: 'denied' as const, privyUserId, multisig };
      if (!challengeFits(challenge, { privyUserId, sessionId, multisig, purpose: 'change' }) || !challenge?.op || !challenge.class ||
        !challenge.waived || !challenge.webauthnUserId || ENROLL_OP_TYPES.has(challenge.op.type) !== (route === 'enroll')) {
        throw failure(new LayerError(LAYER_MESSAGES.invalid, 403, 'challenge-invalid'), { ...event, reason: 'challenge invalid' });
      }
      const op = challenge.op, changeClass = challenge.class, waived = challenge.waived;
      // Asynchronous checks outside the store lock.
      const verifiedConfig = current(multisig, now()).config;
      const passkey = await verifyPasskey(evidence.passkey, verifiedConfig, challenge);
      let registration: VerifiedPasskey | null = null;
      if (op.type === 'passkey.add') {
        try {
          registration = await verifyRegistration({ response: evidence.registration, expectedChallenge: webauthnChallenge('create', challenge.nonce, challenge.digest), config: passkeySettings() });
        } catch (error) {
          if (!(error instanceof PasskeyCheckError)) throw error;
          throw failure(new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: [{ id: 'biometrics', ok: false, reason: error.message }] }),
            { ...event, class: changeClass, layers: [{ id: 'biometrics', ok: false }], reason: 'new passkey not verified' });
        }
      }
      let key: DeviceKeyRecord | null;
      if (op.type === 'device.add') {
        const { spki } = importDeviceKey(op.publicKeySpki);
        key = { keyId: keyIdOf(spki), publicKeySpki: op.publicKeySpki, surface: op.surface };
      } else key = trustedKey(evidence.device, verifiedConfig);
      const device = verifyDevice(evidence.device, key);
      const needsDevice = needsDeviceReading(verifiedConfig, challenge.required) || captures(op);
      if (needsDevice && !device) {
        throw failure(new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: [{ id: readingLayer(op), ok: false, reason: LAYER_FAILURES.untrustedDevice }] }),
          { ...event, class: changeClass, reason: 'device evidence missing' });
      }
      // The vault's authenticator, when MFA is on and this change needs every layer.
      const totp = challenge.required.includes('mfa') ? verifyTotp(evidence.totp, verifiedConfig, multisig, now()) : null;
      // mfa.add: a code from the new secret proves the authenticator app holds it before anything is stored.
      let newTotp: { secret: string; step: number } | null = null;
      if (op.type === 'mfa.add') {
        const secret = base32Decode(challenge.totpSecret);
        const step = secret && evidence.totp ? matchTotp(secret, evidence.totp.code, now()) : null;
        if (!challenge.totpSecret || step === null) {
          throw failure(new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: [{ id: 'mfa', ok: false, reason: evidence.totp ? LAYER_FAILURES.totp : LAYER_FAILURES.totpMissing }] }),
            { ...event, class: changeClass, layers: [{ id: 'mfa', ok: false }], reason: 'new authenticator not confirmed' });
        }
        newTotp = { secret: challenge.totpSecret, step };
      }
      return store.withLock((): ChangeFinishResponse => {
        const at = now();
        const { stored, config } = current(multisig, at);
        if ((config?.version ?? 0) !== challenge.configVersion) {
          audit({ ...event, class: changeClass, reason: 'challenge stale' });
          throw new LayerError(LAYER_MESSAGES.stale, 409, 'challenge-stale');
        }
        // An immediate first passkey needs this session's activation window to be open still; it is used once.
        const firstPasskey = op.type === 'passkey.add' && changeClass === 'tighten' && !config?.biometrics;
        if (firstPasskey && activationFor(privyUserId, readStore(() => store.getVault(multisig)) ?? vault, sessionId, at) !== 'session') {
          audit({ ...event, class: changeClass, reason: 'activation window closed' });
          throw new LayerError(LAYER_MESSAGES.stale, 409, 'challenge-stale');
        }
        const network = observe(context);
        requireObservableNetwork(challenge.required, network);
        const radioCapture = op.type === 'wifi.add-bssid' ? { radioId: op.radioId } : op.type === 'wifi.add-radio' ? { newRadio: true as const } : undefined;
        const result = evaluateLayers({ config, required: challenge.required, challenge, passkey, device, totp, network, now: at, ...(radioCapture ? { radioCapture } : {}) });
        const base = config ?? emptyLayerConfig(challenge.webauthnUserId!, iso(at));
        const passkeyCounted = result.ok ? withCounter(base, passkey) : null;
        const counted = passkeyCounted ? withTotpStep(passkeyCounted, totp) : null;
        if (!result.ok || !counted) {
          const results = result.ok ? result.layers.map(layer => layer.id === 'biometrics' && !passkeyCounted ? { id: layer.id, ok: false, reason: LAYER_FAILURES.passkey }
            : layer.id === 'mfa' && passkeyCounted && !counted ? { id: layer.id, ok: false, reason: LAYER_FAILURES.totp } : layer) : result.layers;
          throw failure(new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: results }),
            { ...event, class: changeClass, layers: layerResults(results), reason: 'protection layer failed' });
        }
        // Surface consistency: a passkey and a device reading must come from the same app.
        const surface: Surface | null = passkey?.ok ? passkey.facts.surface : registration?.surface ?? (device?.ok ? device.key.surface : null);
        if (passkey?.ok && registration && registration.surface !== passkey.facts.surface) {
          throw failure(new LayerError(LAYER_MESSAGES.changeFailed, 403, 'layer-failed', { layers: [{ id: 'biometrics', ok: false, reason: LAYER_FAILURES.mixedApps }] }),
            { ...event, class: changeClass, reason: 'evidence from different apps' });
        }
        let applied: AppliedChangeOp;
        try { applied = captureOp({ op, config, at, challenge, registration, device, network, newTotp }); }
        catch (error) {
          if (error instanceof LayerError) throw failure(error, { ...event, class: changeClass, reason: 'capture failed' });
          throw error;
        }
        const summary = summariseChange(applied);
        let next: VaultLayerConfig;
        let answer: ChangeFinishResponse;
        // Tighten and loosen apply now (a loosening has just passed every layer that is on); only recovery waits.
        if (changeClass !== 'recovery') {
          try { next = applyChange(counted, applied); }
          catch (error) { if (error instanceof ChangeNotApplicableError) throw conflict('This change no longer applies. Reload and try again.'); throw error; }
          next.version = base.version + 1;
          next.history = [...next.history, { id: randomId('chg'), summary, class: changeClass, outcome: 'applied' as const, at: iso(at) }].slice(-HISTORY_LIMIT);
          answer = { status: 'applied', configVersion: next.version };
        } else {
          const change: PendingChange = { id: randomId('chg'), op: applied, class: changeClass, waived: [...waived], requestedAt: iso(at), effectiveAt: iso(at + RECOVERY_DELAY_MS), requestedFrom: surface };
          next = { ...counted, pending: [...counted.pending, change].sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt)), version: base.version + 1 };
          answer = { status: 'pending', change: { id: change.id, class: changeClass, effectiveAt: change.effectiveAt } };
        }
        next.updatedAt = iso(at);
        write(multisig, stored, next);
        // The window is used once. The passkey is already stored, and a vault with a passkey never reads the window
        // again, so a failure to remove it is only logged.
        if (firstPasskey) {
          try { store.closeActivation(multisig); }
          catch (error) { console.error(JSON.stringify({ event: 'antara.guardian.layers', outcome: 'error', reason: 'first-passkey window not closed', code: error instanceof VaultStoreError ? error.code : 'unknown' })); }
        }
        audit({ action, outcome: answer.status === 'applied' ? 'applied' : 'pending', privyUserId, multisig, class: changeClass, layers: layerResults(result.layers) });
        return answer;
      });
    },

    async cancelChange(privyUserId, body, _context) {
      if (!hasOnlyKeys(body, ['multisig', 'changeId'])) throw invalid('The cancel request is malformed.');
      const multisig = parseMultisig(body.multisig);
      if (typeof body.changeId !== 'string' || !CHANGE_ID.test(body.changeId)) throw invalid('Unknown change.');
      const changeId = body.changeId;
      await owned(privyUserId, multisig, 'cancel');
      // Cancelling restores protection, so it needs only the session, and is never locked out.
      return store.withLock(() => {
        const at = now();
        const { stored, config } = current(multisig, at);
        const change = config?.pending.find(item => item.id === changeId);
        if (!stored || !config || !change) throw conflict('This change is no longer pending. It may already have taken effect.');
        const next: VaultLayerConfig = {
          ...config, pending: config.pending.filter(item => item.id !== changeId), version: config.version + 1, updatedAt: iso(at),
          history: [...config.history, { id: change.id, summary: summariseChange(change.op), class: change.class, outcome: 'cancelled' as const, at: iso(at) }].slice(-HISTORY_LIMIT),
        };
        write(multisig, stored, next);
        audit({ action: 'cancel', outcome: 'cancelled', privyUserId, multisig, class: change.class });
        return { status: 'cancelled' as const, configVersion: next.version };
      });
    },

    async limits(privyUserId, multisigValue) {
      const multisig = parseMultisig(multisigValue);
      const { user } = await owned(privyUserId, multisig, null);
      const at = now();
      const { config } = current(multisig, at);
      const limits = limitsFor(config);
      const ledger = readStore(() => store.ledger());
      const owner = { privyUserId: user.id, multisig };
      let used: { SOL: string; USDC: string };
      try { used = { SOL: usageInWindow(ledger, owner, 'SOL', at).toString(), USDC: usageInWindow(ledger, owner, 'USDC', at).toString() }; }
      catch { throw unavailable('The approval ledger could not be read. Nothing was approved or changed.'); }
      return { multisig, limits: rawCaps(limits), usedLast24h: used };
    },
  };
}

/**
 * Production wiring, mirroring pairedVaultGuardianFromEnv: the same pinned
 * guardian address and cluster, store file and RPC. Throws GuardianError (503)
 * when any of them is missing or invalid.
 */
export function vaultLayerServiceFromEnv(options: {
  privy: PrivyClient; rpcUrl: string; trustProxy: number | false; clientIpHeader?: string | null; env?: NodeJS.ProcessEnv; store?: VaultStore; fetch?: typeof fetch;
}): VaultLayerService {
  const env = options.env ?? process.env;
  const guardian = readGuardianConfig(env);
  let store: VaultStore;
  try { store = options.store ?? createVaultStore(vaultStorePath(env), vaultStoreOptions(env)); } catch (error) { throw unavailable(error instanceof Error ? error.message : 'Vault storage is not configured.'); }
  return createVaultLayerService({
    store, rpc: solanaJsonRpc(options.rpcUrl, { fetch: options.fetch }), cluster: guardian.cluster, guardian: guardian.address,
    loadUser: async id => privyUserFacts(await options.privy.users()._get(id)),
    passkeyConfig: () => layerServerConfig(env),
    totpKey: () => totpKeyFromEnv(env),
    network: { production: env.NODE_ENV === 'production', trustProxy: options.trustProxy, clientIpHeader: options.clientIpHeader ?? null },
  });
}

