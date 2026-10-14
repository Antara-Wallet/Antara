/**
 * Persistent paired-vault registrations, the guardian approval ledger and each
 * vault's protection-layer configuration (docs/VAULT_LAYERS.md §5.1).
 *
 * Stored as one JSON document in DATA_DIR (a Render persistent disk in
 * production) with the same atomic-replace and fail-closed rules as the other
 * security stores: anything unreadable, corrupt or structurally unexpected
 * throws, and callers deny. The file is re-read and fully validated on every
 * operation, so a damaged disk can never look like an empty ledger, or like a
 * vault without protection layers.
 *
 * A missing document is not silently a fresh install either. A marker file is
 * written next to it when the store is first initialised (or first written).
 * A missing document with the marker present means storage was lost, and the
 * store refuses. In production a store with neither also refuses (a wrong
 * DATA_DIR, or an unmounted or wiped disk) until the operator deliberately
 * sets ANTARA_VAULT_STORE_INIT=1 for one start. The server opens the store at
 * start-up (initialiseVaultStoreAtBoot) and logs `initialised`, `ready` or
 * `refused`, so that start creates the marker even if no vault route is called.
 *
 * Ledger entries are idempotent per (multisig, transactionIndex): an approval
 * is reserved before the guardian signs and keeps counting toward a daily cap
 * the user set (Limits layer) even if the signature or broadcast later fails.
 *
 * Release authorizations: the server's stores (vaultStoreOptions) refuse a
 * reservation unless it consumes a short-lived, single-use grant that the
 * protection-layer step made for that exact proposal and account. The caps the
 * user set for the vault (if any) are re-checked against the ledger in the same
 * locked section as the reservation, and the layers that passed are recorded on it. So no caller
 * of the guardian service can reserve, and so sign, a vote that skipped the
 * layers. Grants live in memory: a restart drops them, which fails closed.
 *
 * Document versions: version 1 (no layers) is still read, as a vault without
 * layer configuration; every write produces version 2. A server that only
 * knows version 1 refuses a version 2 document ("unexpected format"), which
 * fails closed. A registration may carry its first-passkey window
 * (`activation`, optional, validated when present), so the window survives a
 * restart; servers that predate the field read and keep it unchanged.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validLayerConfig, validLayerPass } from './layers/schema.js';
import { RELEASE_AUTHORIZATION_TTL_MS, type LedgerLayerPass, type VaultLayerConfig } from './layers/types.js';
import { readSecurityStore, writeSecurityStore } from './storage.js';
import { usageInWindow } from './vaultPolicy.js';

export type PairedVaultAsset = 'SOL' | 'USDC';
export interface PairedVaultRecord {
  privyUserId: string;
  /** U: the user's Privy embedded Solana wallet (Initiate|Vote|Execute). */
  user: string;
  multisig: string;
  /** G at registration time; a rotated guardian never approves older vaults. */
  guardian: string;
  /** Vault PDA index 0 (the deposit address). */
  vault: string;
  createdAt: string;
  /**
   * The vault's first-passkey window (layers/service.ts noteRegistration), stored with the registration so a restart
   * or deploy does not close it. Optional and ignored by servers that predate it, so the document format is unchanged.
   */
  activation?: PairedVaultActivation;
}
/**
 * The window in which the vault's first passkey applies at once, from one Privy session only. Recorded at most once
 * per vault (never moved to another session) and removed when that first passkey uses it.
 */
export interface PairedVaultActivation {
  privyUserId: string;
  /** SHA-256 (hex) of the Privy session id the window is bound to; the session id itself is never stored. */
  sessionHash: string;
  openedAt: string;
  /** The registration time plus ACTIVATION_WINDOW_MS (layers/types.ts): never later. */
  expiresAt: string;
}
export interface LedgerEntry {
  multisig: string;
  transactionIndex: string;
  privyUserId: string;
  asset: PairedVaultAsset;
  amountRaw: string;
  recipient: string;
  /** When the approval was reserved; counts toward a user-set daily cap from this instant. */
  approvedAt: string;
  /** Guardian vote signature once Privy returned one. */
  signature?: string;
  /** When that signature was recorded; a repeat request within the blockhash lifetime is answered "pending". */
  signedAt?: string;
  /** The protection layers that passed for this release (no readings). */
  layers?: LedgerLayerPass;
}
interface StoreDocument {
  version: 2;
  vaults: Record<string, PairedVaultRecord>;
  ledger: Record<string, LedgerEntry>;
  /** Keyed by multisig; absent means no optional layers and no release caps. */
  layers: Record<string, VaultLayerConfig>;
}

export class VaultStoreError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'conflict' | 'configuration' = 'invalid') { super(message); this.name = 'VaultStoreError'; }
}

export const VAULT_STORE_FILE = 'paired-vaults-solana.json';
/** Written once when the store is initialised; while it exists, the document must exist too. */
export const VAULT_STORE_MARKER = 'paired-vaults-solana.initialised';
/** Entries older than this are pruned on write; a user-set daily cap only looks back 24 hours. */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const VAULT_STORE_VERSION = 2;

/**
 * Store location. In production DATA_DIR must be set explicitly (a persistent
 * disk): falling back to the ephemeral working directory would silently reset
 * the ledger (vote records and any user-set daily cap) on every deploy.
 */
export function vaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.DATA_DIR?.trim();
  if (!dir && env.NODE_ENV === 'production') throw new VaultStoreError('DATA_DIR must point at a persistent disk before paired vaults are enabled.', 'configuration');
  return resolve(dir || resolve(process.cwd(), 'data'), VAULT_STORE_FILE);
}

export interface VaultStoreOptions {
  /** Refuse a missing document unless this is a deliberate fresh install (production). */
  requireInitialised?: boolean;
  /** Deliberate fresh install: write the marker now when neither the marker nor the document exists. */
  initialise?: boolean;
  /**
   * Every reservation of a guardian vote (recordApproval) must consume a
   * release authorization that the protection-layer step granted
   * (authorizeRelease). The server's stores always set it (vaultStoreOptions),
   * so no caller of the guardian can reserve, and so sign, a vote that skipped
   * the layers or the vault's own limits.
   */
  requireReleaseAuthorization?: boolean;
}
/**
 * The server's store options. Production refuses an uninitialised store unless
 * ANTARA_VAULT_STORE_INIT=1 is set for one deliberate start. Every environment
 * requires a release authorization for each reservation (a passkey is required
 * for every release, so every vote passes the layer step).
 */
export function vaultStoreOptions(env: NodeJS.ProcessEnv = process.env): VaultStoreOptions {
  const initialise = env.ANTARA_VAULT_STORE_INIT?.trim() === '1';
  return { requireInitialised: env.NODE_ENV === 'production' && !initialise, initialise, requireReleaseAuthorization: true };
}

/**
 * A release that passed the vault's protection layers (layers/service.ts
 * authorizeRelease), granted under the store lock and consumed by the
 * guardian's reservation under the store lock. In memory, per store file,
 * single use and short-lived: a restart drops it, which fails closed.
 */
export interface ReleaseAuthorization {
  privyUserId: string;
  /** The layers that passed, recorded on the reservation; null for a retry of a reservation whose layers passed within 30 minutes. */
  pass: LedgerLayerPass | null;
  /**
   * The caps the user set for this vault through the Limits layer (raw units; null = no cap, the default), checked
   * against the ledger in the same locked section as the reservation. There is no server-wide cap.
   */
  limits: { perReleaseRaw: Readonly<Record<PairedVaultAsset, string | null>>; perDayRaw: Readonly<Record<PairedVaultAsset, string | null>> };
  /** The stored layer-configuration version when it was granted (null: none stored); a write since then refuses the reservation. */
  layerVersion: number | null;
  /** ms since the epoch, on the same clock as the reservation's `now`. */
  expiresAt: number;
}
export const RELEASE_NOT_AUTHORIZED = "This release has not passed the vault's protection layers. Nothing was approved.";
const validAuthorization = (value: ReleaseAuthorization) => isId(value?.privyUserId) && (value.pass === null || validLayerPass(value.pass)) &&
  (['perReleaseRaw', 'perDayRaw'] as const).every(kind => (['SOL', 'USDC'] as const).every(asset => {
    const cap = value.limits?.[kind]?.[asset];
    return cap === null || (typeof cap === 'string' && POSITIVE.test(cap));
  })) &&
  (value.layerVersion === null || (Number.isInteger(value.layerVersion) && value.layerVersion >= 1)) && Number.isFinite(value.expiresAt);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const POSITIVE = /^[1-9]\d{0,38}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const ledgerKey = (multisig: string, transactionIndex: string) => `${multisig}:${transactionIndex}`;
const emptyDocument = (): StoreDocument => ({ version: 2, vaults: {}, ledger: {}, layers: {} });

const SESSION_HASH = /^[0-9a-f]{64}$/;
const ACTIVATION_KEYS = ['privyUserId', 'sessionHash', 'openedAt', 'expiresAt'];
function validActivation(value: unknown, privyUserId: unknown): value is PairedVaultActivation {
  return isRecord(value) && Object.keys(value).length === ACTIVATION_KEYS.length && ACTIVATION_KEYS.every(key => key in value) &&
    isId(value.privyUserId) && value.privyUserId === privyUserId && SESSION_HASH.test(String(value.sessionHash)) && isIso(value.openedAt) && isIso(value.expiresAt);
}
function validRecord(key: string, value: unknown): value is PairedVaultRecord {
  return isRecord(value) && value.multisig === key && isId(value.privyUserId) && BASE58.test(String(value.user)) && BASE58.test(String(value.multisig)) &&
    BASE58.test(String(value.guardian)) && BASE58.test(String(value.vault)) && isIso(value.createdAt) &&
    (value.activation === undefined || validActivation(value.activation, value.privyUserId));
}
function validEntry(key: string, value: unknown): value is LedgerEntry {
  return isRecord(value) && typeof value.multisig === 'string' && typeof value.transactionIndex === 'string' && key === ledgerKey(value.multisig, value.transactionIndex) &&
    BASE58.test(value.multisig) && POSITIVE.test(value.transactionIndex) && isId(value.privyUserId) && (value.asset === 'SOL' || value.asset === 'USDC') &&
    POSITIVE.test(String(value.amountRaw)) && BASE58.test(String(value.recipient)) && isIso(value.approvedAt) &&
    (value.signature === undefined || SIGNATURE.test(String(value.signature))) &&
    (value.signedAt === undefined || (value.signature !== undefined && isIso(value.signedAt))) &&
    (value.layers === undefined || validLayerPass(value.layers));
}

function readDocument(file: string, marker: string, options: VaultStoreOptions): StoreDocument {
  if (!existsSync(file)) {
    if (existsSync(marker)) throw new VaultStoreError('Paired-vault storage was initialised on this disk but its data file is missing. Restore a verified backup before approving releases.');
    if (options.requireInitialised) {
      throw new VaultStoreError('Paired-vault storage is not initialised on this disk. Check DATA_DIR and the disk mount; for a deliberate fresh install set ANTARA_VAULT_STORE_INIT=1 for one start.', 'configuration');
    }
    return emptyDocument();
  }
  let value: Record<string, unknown>;
  try { value = readSecurityStore<Record<string, unknown>>(file); }
  catch { throw new VaultStoreError('Paired-vault storage is unreadable. Restore a verified backup before approving releases.'); }
  if (Object.keys(value).length === 0) return emptyDocument();
  // Version 1 had no layers: it reads as a store in which no vault has layer configuration.
  const keys = value.version === 1 ? ['version', 'vaults', 'ledger'] : value.version === VAULT_STORE_VERSION ? ['version', 'vaults', 'ledger', 'layers'] : null;
  if (!keys || !Object.keys(value).every(key => keys.includes(key)) || !isRecord(value.vaults) || !isRecord(value.ledger) ||
    (value.version === VAULT_STORE_VERSION && !isRecord(value.layers))) throw new VaultStoreError('Paired-vault storage has an unexpected format.');
  for (const [key, record] of Object.entries(value.vaults)) if (!validRecord(key, record)) throw new VaultStoreError('Paired-vault storage contains an invalid registration.');
  for (const [key, entry] of Object.entries(value.ledger)) if (!validEntry(key, entry)) throw new VaultStoreError('Paired-vault storage contains an invalid ledger entry.');
  const layers = (value.version === VAULT_STORE_VERSION ? value.layers : {}) as Record<string, unknown>;
  for (const [key, config] of Object.entries(layers)) {
    // Layer configuration exists only for a registered vault, and is validated in full.
    if (!BASE58.test(key) || !(value.vaults as Record<string, unknown>)[key] || !validLayerConfig(config)) throw new VaultStoreError('Paired-vault storage contains an invalid protection-layer configuration.');
  }
  return { version: 2, vaults: value.vaults as Record<string, PairedVaultRecord>, ledger: value.ledger as Record<string, LedgerEntry>, layers: layers as Record<string, VaultLayerConfig> };
}

// One queue per file across store instances: evaluation and reservation of
// limits must not interleave, or two releases could each see the old total.
const queues = new Map<string, Promise<unknown>>();
// Release authorizations per file (shared by the guardian's and the layer service's store instances), keyed by ledger key.
const authorizations = new Map<string, Map<string, ReleaseAuthorization>>();

export interface VaultStore {
  readonly file: string;
  getVault(multisig: string): PairedVaultRecord | null;
  vaultsForUser(privyUserId: string): PairedVaultRecord[];
  /** Idempotent for the same user, wallet and guardian; a different binding is a conflict. */
  registerVault(record: PairedVaultRecord): { record: PairedVaultRecord; created: boolean };
  /**
   * Records the vault's first-passkey window on its registration (layers/service.ts, under the store lock). Never
   * replaces one: false when a window was already recorded. The vault must be registered to the window's account.
   */
  openActivation(multisig: string, activation: PairedVaultActivation): boolean;
  /** Removes the vault's first-passkey window, once its first passkey used it. */
  closeActivation(multisig: string): void;
  ledger(): LedgerEntry[];
  ledgerEntry(multisig: string, transactionIndex: string): LedgerEntry | null;
  /**
   * Idempotent per (multisig, transactionIndex); a different amount, asset, user or recipient is a conflict.
   * With `requireReleaseAuthorization`, every reservation (anything but recording a new guardian signature on
   * an existing reservation) consumes this proposal's release authorization, refuses without one (`conflict`,
   * RELEASE_NOT_AUTHORIZED), re-checks the vault's limits against the ledger, and records the layers that passed.
   */
  recordApproval(entry: LedgerEntry, now?: number): { entry: LedgerEntry; created: boolean };
  /**
   * Grants the guardian one reservation of this proposal (layers/service.ts authorizeRelease only, under the
   * store lock). Replaces an earlier grant for the same proposal.
   */
  authorizeRelease(multisig: string, transactionIndex: string, authorization: ReleaseAuthorization): void;
  /** The vault's stored layer configuration (pending changes not applied), or null when it has none. */
  layerConfig(multisig: string): VaultLayerConfig | null;
  /**
   * Replaces the vault's layer configuration. Optimistic: `expectedVersion` is
   * the stored version the caller read (null: none stored); anything else is
   * a conflict. The vault must be registered and `next` must validate.
   */
  writeLayerConfig(multisig: string, expectedVersion: number | null, next: VaultLayerConfig): VaultLayerConfig;
  /** Runs `work` exclusively with every other locked section for this file. */
  withLock<T>(work: () => Promise<T> | T): Promise<T>;
}

function writeMarker(marker: string) {
  writeSecurityStore(marker, { version: 1, storeId: randomUUID(), createdAt: new Date().toISOString() });
}

export function createVaultStore(file: string = vaultStorePath(), options: VaultStoreOptions = {}): VaultStore {
  const marker = join(dirname(file), VAULT_STORE_MARKER);
  const read = () => readDocument(file, marker, options);
  // The marker is recorded before the first document write, so losing the document later is detected.
  const write = (document: StoreDocument) => {
    if (!existsSync(marker)) writeMarker(marker);
    writeSecurityStore(file, document);
  };
  // A deliberate fresh install creates the marker and an empty document as soon as a store is
  // opened. The server opens one at start-up (initialiseVaultStoreAtBoot, from the default
  // paired-vault router), independent of guardian provisioning, so the flag can be removed
  // after the start whose log says "initialised".
  if (options.initialise && !existsSync(marker) && !existsSync(file)) write(emptyDocument());
  const store: VaultStore = {
    file,
    getVault(multisig) { return read().vaults[multisig] ?? null; },
    vaultsForUser(privyUserId) { return Object.values(read().vaults).filter(record => record.privyUserId === privyUserId); },
    registerVault(record) {
      if (!validRecord(record.multisig, record)) throw new VaultStoreError('The vault registration is invalid.');
      const document = read();
      const existing = document.vaults[record.multisig];
      if (existing) {
        if (existing.privyUserId !== record.privyUserId || existing.user !== record.user || existing.guardian !== record.guardian || existing.vault !== record.vault) {
          throw new VaultStoreError('This vault is already registered to another account.', 'conflict');
        }
        return { record: existing, created: false };
      }
      document.vaults[record.multisig] = { ...record };
      write(document);
      return { record, created: true };
    },
    openActivation(multisig, activation) {
      if (!BASE58.test(multisig) || !validActivation(activation, activation?.privyUserId)) throw new VaultStoreError('The first-passkey window is invalid.');
      const document = read();
      const record = document.vaults[multisig];
      if (!record || record.privyUserId !== activation.privyUserId) throw new VaultStoreError('This vault is not registered to this account.', 'conflict');
      if (record.activation) return false;
      const { privyUserId, sessionHash, openedAt, expiresAt } = activation;
      document.vaults[multisig] = { ...record, activation: { privyUserId, sessionHash, openedAt, expiresAt } };
      write(document);
      return true;
    },
    closeActivation(multisig) {
      const document = read();
      const record = document.vaults[multisig];
      if (!record?.activation) return;
      const rest: PairedVaultRecord = { ...record };
      delete rest.activation;
      document.vaults[multisig] = rest;
      write(document);
    },
    ledger() { return Object.values(read().ledger); },
    ledgerEntry(multisig, transactionIndex) { return read().ledger[ledgerKey(multisig, transactionIndex)] ?? null; },
    recordApproval(entry, now = Date.now()) {
      const key = ledgerKey(entry.multisig, entry.transactionIndex);
      if (!validEntry(key, entry)) throw new VaultStoreError('The ledger entry is invalid.');
      const document = read();
      const existing = document.ledger[key];
      // Recording the guardian's new signature on an existing reservation follows a vote; anything else reserves one.
      const reserving = !existing || !entry.signature || entry.signature === existing.signature;
      let pass: LedgerLayerPass | null = null;
      if (reserving && options.requireReleaseAuthorization) {
        // Single use, even when a check below refuses.
        const grants = authorizations.get(file);
        const authorization = grants?.get(key) ?? null;
        grants?.delete(key);
        if (!authorization || authorization.expiresAt <= now || authorization.privyUserId !== entry.privyUserId) throw new VaultStoreError(RELEASE_NOT_AUTHORIZED, 'conflict');
        if ((document.layers[entry.multisig]?.version ?? null) !== authorization.layerVersion) {
          throw new VaultStoreError('The vault protection layers changed in the meantime. Start again.', 'conflict');
        }
        // The caps the user set for this vault, if any, in the same locked section as the reservation: no other reservation can slip in between.
        const amount = BigInt(entry.amountRaw);
        const perRelease = authorization.limits.perReleaseRaw[entry.asset], perDay = authorization.limits.perDayRaw[entry.asset];
        const used = perDay === null ? 0n : usageInWindow(Object.values(document.ledger), { privyUserId: entry.privyUserId, multisig: entry.multisig }, entry.asset, now, entry);
        if ((perRelease !== null && amount > BigInt(perRelease)) || (perDay !== null && used + amount > BigInt(perDay))) {
          throw new VaultStoreError("This release is over the limits you set for this vault. Nothing was approved.", 'conflict');
        }
        pass = authorization.pass;
      }
      if (existing) {
        if (existing.privyUserId !== entry.privyUserId || existing.asset !== entry.asset || existing.amountRaw !== entry.amountRaw || existing.recipient !== entry.recipient) {
          throw new VaultStoreError('A different approval is already recorded for this proposal.', 'conflict');
        }
        if (!entry.signature || (existing.signature === entry.signature && existing.signedAt !== undefined)) {
          if (!pass) return { entry: existing, created: false };
          const passed: LedgerEntry = { ...existing, layers: { ...pass, enforced: [...pass.enforced] } };
          document.ledger[key] = passed;
          write(document);
          return { entry: passed, created: false };
        }
        // A new (or first) guardian signature for this reservation; its time drives the "pending" window.
        const updated: LedgerEntry = { ...existing, signature: entry.signature, signedAt: entry.signedAt ?? new Date(now).toISOString(), ...(pass ? { layers: { ...pass, enforced: [...pass.enforced] } } : {}) };
        document.ledger[key] = updated;
        write(document);
        return { entry: updated, created: false };
      }
      for (const [id, item] of Object.entries(document.ledger)) if (now - Date.parse(item.approvedAt) > LEDGER_RETENTION_MS) delete document.ledger[id];
      const created: LedgerEntry = { ...entry, ...(pass ? { layers: { ...pass, enforced: [...pass.enforced] } } : {}) };
      document.ledger[key] = created;
      write(document);
      return { entry: created, created: true };
    },
    authorizeRelease(multisig, transactionIndex, authorization) {
      if (!BASE58.test(multisig) || !POSITIVE.test(transactionIndex) || !validAuthorization(authorization)) throw new VaultStoreError('The release authorization is invalid.');
      const grants = authorizations.get(file) ?? new Map<string, ReleaseAuthorization>();
      authorizations.set(file, grants);
      // Grants that had expired when this one was issued (on the granting clock) are dropped; a reservation consumes the rest.
      for (const [id, item] of grants) if (item.expiresAt <= authorization.expiresAt - RELEASE_AUTHORIZATION_TTL_MS) grants.delete(id);
      grants.set(ledgerKey(multisig, transactionIndex), structuredClone(authorization));
    },
    layerConfig(multisig) {
      const config = read().layers[multisig];
      // A document written before the vault authenticator existed has no `mfa`: MFA is off for that vault.
      return config ? { ...structuredClone(config), mfa: config.mfa ?? null } : null;
    },
    writeLayerConfig(multisig, expectedVersion, next) {
      if (!BASE58.test(multisig) || !validLayerConfig(next)) throw new VaultStoreError('The protection-layer configuration is invalid.');
      const document = read();
      if (!document.vaults[multisig]) throw new VaultStoreError('This vault is not registered.', 'conflict');
      const current = document.layers[multisig];
      if ((current?.version ?? null) !== expectedVersion || next.version < (current?.version ?? 1)) {
        throw new VaultStoreError('The vault protection layers changed in the meantime. Start again.', 'conflict');
      }
      document.layers[multisig] = structuredClone(next);
      write(document);
      return structuredClone(next);
    },
    withLock<T>(work: () => Promise<T> | T): Promise<T> {
      const previous = queues.get(file) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(work);
      const tail = run.catch(() => undefined);
      queues.set(file, tail);
      void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
      return run;
    },
  };
  return store;
}

export interface VaultStoreBootResult {
  /** `initialised`: this start wrote the marker and an empty store. `ready`: the store opened and validated. `refused`: it did not. */
  outcome: 'initialised' | 'ready' | 'refused';
  /** ANTARA's own text, or a filesystem error code. Never a path, key or other value. */
  reason?: string;
}
/**
 * Opens and fully validates the store once at server start, independent of the
 * guardian settings, so a deliberate fresh install (ANTARA_VAULT_STORE_INIT=1)
 * writes its marker during that start even if nobody opens the Vault tab, and a
 * wrong DATA_DIR, unmounted disk or lost document shows up in the boot log.
 * Apart from that deliberate initialisation it only reads.
 */
export function initialiseVaultStoreAtBoot(env: NodeJS.ProcessEnv = process.env): VaultStoreBootResult {
  try {
    const file = vaultStorePath(env);
    const marker = join(dirname(file), VAULT_STORE_MARKER);
    const hadMarker = existsSync(marker);
    createVaultStore(file, vaultStoreOptions(env)).ledger();
    return { outcome: !hadMarker && existsSync(marker) ? 'initialised' : 'ready' };
  } catch (error) {
    if (error instanceof VaultStoreError) return { outcome: 'refused', reason: error.message };
    const code = (error as { code?: unknown } | null)?.code;
    return { outcome: 'refused', reason: typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) ? `filesystem error ${code}` : 'Paired-vault storage could not be opened.' };
  }
}
