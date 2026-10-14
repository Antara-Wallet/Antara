/**
 * Trusted device keys (docs/VAULT_LAYERS.md section 5.3). One non-extractable WebCrypto
 * ECDSA P-256 key per ANTARA user, vault and device signs every device-reported reading.
 * It lives in this app's or browser's IndexedDB: a software key, not secure hardware.
 * Without IndexedDB or WebCrypto there is no fallback storage, so device-reported layers
 * are unavailable on that device.
 */
import { base64UrlEncode, encodeDevicePayload, sha256 } from './evidence';
import { SURFACES, type DevicePayloadV1, type SignedDevicePayload, type Surface } from './types';

export interface DeviceKeyRecord { keyPair: CryptoKeyPair; keyId: string; surface: Surface; createdAt: string }
/** Storage seam: IndexedDB in the app, memory in tests. */
export interface DeviceKeyStorage {
  get(name: string): Promise<DeviceKeyRecord | null>;
  put(name: string, record: DeviceKeyRecord): Promise<void>;
}
export interface DeviceKey {
  keyId: string;
  surface: Surface;
  /** base64url SPKI DER. */
  publicKeySpki: string;
  createdAt: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export class DeviceKeyUnavailableError extends Error {
  constructor(message = 'This device cannot keep a trusted device key (secure browser storage is unavailable), so device-reported layers cannot be used here.') {
    super(message); this.name = 'DeviceKeyUnavailableError';
  }
}

export const DEVICE_KEY_DB = 'solares-vault-layers';
export const DEVICE_KEY_STORE = 'device-keys';
export const deviceKeyName = (privyUserId: string, multisig: string) => `${privyUserId}:${multisig}`;
const ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new DeviceKeyUnavailableError();
  return value;
}

/** base64url of the first 16 bytes of SHA-256(SPKI DER): 22 characters. */
export async function keyIdOf(spki: Uint8Array): Promise<string> {
  return base64UrlEncode((await sha256(spki)).slice(0, 16));
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new DeviceKeyUnavailableError());
  });
}

export function indexedDbDeviceKeyStorage(factory: IDBFactory | undefined = globalThis.indexedDB): DeviceKeyStorage {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!factory) return Promise.reject(new DeviceKeyUnavailableError());
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try { opening = factory.open(DEVICE_KEY_DB, 1); } catch { reject(new DeviceKeyUnavailableError()); return; }
      opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains(DEVICE_KEY_STORE)) opening.result.createObjectStore(DEVICE_KEY_STORE); };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(new DeviceKeyUnavailableError());
      opening.onblocked = () => reject(new DeviceKeyUnavailableError('Another ANTARA window is updating this device’s keys. Close it and try again.'));
    }).catch(failure => { database = null; throw failure; });
    return database;
  };
  return {
    async get(name) {
      const db = await open();
      const value = await request(db.transaction(DEVICE_KEY_STORE, 'readonly').objectStore(DEVICE_KEY_STORE).get(name));
      return value === undefined ? null : value as DeviceKeyRecord;
    },
    async put(name, record) {
      const db = await open();
      const transaction = db.transaction(DEVICE_KEY_STORE, 'readwrite');
      transaction.objectStore(DEVICE_KEY_STORE).put(record, name);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new DeviceKeyUnavailableError());
        transaction.onabort = () => reject(transaction.error ?? new DeviceKeyUnavailableError());
      });
    },
  };
}

export function memoryDeviceKeyStorage(): DeviceKeyStorage {
  const records = new Map<string, DeviceKeyRecord>();
  return { get: async name => records.get(name) ?? null, put: async (name, record) => { records.set(name, record); } };
}

async function toDeviceKey(record: DeviceKeyRecord): Promise<DeviceKey> {
  const { privateKey, publicKey } = record.keyPair ?? {};
  // Only a non-extractable P-256 signing key is ever used; anything else is treated as unreadable.
  const algorithm = privateKey?.algorithm as EcKeyAlgorithm | undefined;
  if (!privateKey || !publicKey || privateKey.extractable || algorithm?.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256' || !privateKey.usages.includes('sign') ||
    !(SURFACES as readonly string[]).includes(record.surface)) {
    throw new DeviceKeyUnavailableError('This device’s trusted key is unreadable. Remove this device from your vault and add it again.');
  }
  const spki = new Uint8Array(await subtle().exportKey('spki', publicKey));
  const keyId = await keyIdOf(spki);
  if (keyId !== record.keyId) throw new DeviceKeyUnavailableError('This device’s trusted key is unreadable. Remove this device from your vault and add it again.');
  return {
    keyId, surface: record.surface, publicKeySpki: base64UrlEncode(spki), createdAt: record.createdAt,
    sign: async bytes => new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes as BufferSource)),
  };
}

/** This device's key for the vault, or null when none was created here. */
export async function loadDeviceKey(storage: DeviceKeyStorage, privyUserId: string, multisig: string): Promise<DeviceKey | null> {
  const record = await storage.get(deviceKeyName(privyUserId, multisig));
  return record ? toDeviceKey(record) : null;
}

/** Returns this device's key for the vault, creating it (non-extractable) when there is none. */
export async function ensureDeviceKey(storage: DeviceKeyStorage, privyUserId: string, multisig: string, surface: Surface, now = () => Date.now()): Promise<DeviceKey> {
  const existing = await loadDeviceKey(storage, privyUserId, multisig);
  if (existing) return existing;
  const keyPair = await subtle().generateKey(ALGORITHM, false, ['sign', 'verify']) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey('spki', keyPair.publicKey));
  const record: DeviceKeyRecord = { keyPair, keyId: await keyIdOf(spki), surface, createdAt: new Date(now()).toISOString() };
  await storage.put(deviceKeyName(privyUserId, multisig), record);
  return toDeviceKey(record);
}

/** Signs the exact payload bytes. WebCrypto ECDSA signatures are already IEEE P1363 (r || s, 64 bytes for P-256). */
export async function signDevicePayload(key: DeviceKey, payload: DevicePayloadV1): Promise<SignedDevicePayload> {
  if (payload.keyId !== key.keyId || payload.surface !== key.surface) throw new Error('The reading was prepared for a different device key.');
  const bytes = encodeDevicePayload(payload);
  const signature = await key.sign(bytes);
  if (signature.length !== 64) throw new Error('This device produced an unexpected signature.');
  return { keyId: key.keyId, payload: base64UrlEncode(bytes), signature: base64UrlEncode(signature) };
}
