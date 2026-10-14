/**
 * Trusted devices: device-reported readings are signed by a per-vault,
 * per-device, non-extractable WebCrypto P-256 key (IndexedDB). This is a
 * software key in the app's or browser's profile, not secure hardware: it
 * proves which enrolled device sent a reading, never that the reading is true.
 *
 * The signature is checked over the exact payload bytes first; only then is
 * the JSON parsed, strictly (unknown keys refused, every number finite).
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { fromBase64Url, hasOnlyKeys, sha256, toBase64Url } from './codec.js';
import {
  PAYLOAD_MAX_BYTES, SURFACES,
  type BluetoothSource, type DeviceBluetoothReading, type DeviceEvidence, type DeviceGeoReading, type DevicePayloadV1, type DeviceWifiReading, type GeoSource, type Surface,
} from './types.js';

export class DeviceCheckError extends Error {
  constructor(message: string) { super(message); this.name = 'DeviceCheckError'; }
}

/** Imports a base64url SPKI DER P-256 public key; anything else (P-384, RSA, non-canonical DER) is refused. */
export function importDeviceKey(publicKeySpki: unknown): { key: KeyObject; spki: Uint8Array } {
  const der = fromBase64Url(publicKeySpki, { min: 32, max: 200 });
  if (!der) throw new DeviceCheckError('The device key is not a P-256 public key.');
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' }); } catch { throw new DeviceCheckError('The device key is not a P-256 public key.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new DeviceCheckError('The device key is not a P-256 public key.');
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (!Buffer.from(der).equals(canonical)) throw new DeviceCheckError('The device key is not a P-256 public key.');
  return { key, spki: der };
}
/** base64url of the first 16 bytes of SHA-256(SPKI DER): 22 characters. */
export const keyIdOf = (spki: Uint8Array): string => toBase64Url(sha256(spki).subarray(0, 16));

export const GEO_SOURCE: Readonly<Record<Surface, GeoSource>> = { desktop: 'windows-location', extension: 'browser-geolocation', web: 'browser-geolocation' };
export const BLUETOOTH_SOURCE: Readonly<Record<Surface, BluetoothSource>> = { desktop: 'windows-classic', extension: 'web-bluetooth', web: 'web-bluetooth' };

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTime = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value > 0 && value < 1e14;
const HEX64 = /^[0-9a-f]{64}$/;
export const SSID_HEX = /^(?:[0-9a-f]{2}){1,32}$/;
export const BSSID = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
export const CLASSIC_IDENTIFIER = /^[0-9A-F]{12}$/;
export const WEB_BLUETOOTH_IDENTIFIER = /^[A-Za-z0-9+/=_-]{1,64}$/;
const BLUETOOTH_NAME_MAX = 64;

function parseGeo(value: unknown): DeviceGeoReading {
  if (!hasOnlyKeys(value, ['lat', 'lng', 'accuracyM', 'at', 'source'])) throw new DeviceCheckError('The location reading is malformed.');
  const { lat, lng, accuracyM, at, source } = value;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng) || !isFiniteNumber(accuracyM) || !isTime(at)) throw new DeviceCheckError('The location reading is malformed.');
  if (source !== 'windows-location' && source !== 'browser-geolocation') throw new DeviceCheckError('The location reading is malformed.');
  return { lat, lng, accuracyM, at, source };
}
function parseWifi(value: unknown): DeviceWifiReading {
  if (!hasOnlyKeys(value, ['connections', 'at', 'source']) || value.source !== 'windows-wlan' || !isTime(value.at) || !Array.isArray(value.connections) ||
    value.connections.length < 1 || value.connections.length > 8) throw new DeviceCheckError('The Wi-Fi reading is malformed.');
  const connections = value.connections.map(item => {
    if (!hasOnlyKeys(item, ['ssidHex', 'bssid']) || typeof item.ssidHex !== 'string' || !SSID_HEX.test(item.ssidHex) || typeof item.bssid !== 'string' || !BSSID.test(item.bssid)) {
      throw new DeviceCheckError('The Wi-Fi reading is malformed.');
    }
    return { ssidHex: item.ssidHex, bssid: item.bssid };
  });
  return { connections, at: value.at, source: 'windows-wlan' };
}
function parseBluetooth(value: unknown): DeviceBluetoothReading {
  if (!hasOnlyKeys(value, ['devices', 'at', 'source']) || (value.source !== 'windows-classic' && value.source !== 'web-bluetooth') || !isTime(value.at) ||
    !Array.isArray(value.devices) || value.devices.length > 8) throw new DeviceCheckError('The Bluetooth reading is malformed.');
  const source = value.source;
  const devices = value.devices.map(item => {
    if (!hasOnlyKeys(item, ['identifier', 'name']) || typeof item.identifier !== 'string' || typeof item.name !== 'string' || item.name.length > BLUETOOTH_NAME_MAX ||
      !(source === 'windows-classic' ? CLASSIC_IDENTIFIER : WEB_BLUETOOTH_IDENTIFIER).test(item.identifier)) {
      throw new DeviceCheckError('The Bluetooth reading is malformed.');
    }
    return { identifier: item.identifier, name: item.name };
  });
  return { devices, at: value.at, source };
}

/** Strict DevicePayloadV1 parse of already-verified bytes. */
export function parseDevicePayload(bytes: Uint8Array): DevicePayloadV1 {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new DeviceCheckError('The device reading is malformed.'); }
  if (!hasOnlyKeys(value, ['v', 'purpose', 'challengeId', 'nonce', 'digest', 'keyId', 'surface', 'signedAt'], ['geo', 'wifi', 'bluetooth'])) {
    throw new DeviceCheckError('The device reading has unexpected or missing fields.');
  }
  if (value.v !== 1 || (value.purpose !== 'release' && value.purpose !== 'change') || typeof value.challengeId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.challengeId) ||
    !fromBase64Url(value.nonce, { exact: 32 }) || typeof value.digest !== 'string' || !HEX64.test(value.digest) || typeof value.keyId !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.keyId) || !(SURFACES as readonly unknown[]).includes(value.surface) || !isTime(value.signedAt)) {
    throw new DeviceCheckError('The device reading is malformed.');
  }
  const payload: DevicePayloadV1 = {
    v: 1, purpose: value.purpose, challengeId: value.challengeId, nonce: value.nonce as string, digest: value.digest, keyId: value.keyId,
    surface: value.surface as Surface, signedAt: value.signedAt,
  };
  if (value.geo !== undefined) payload.geo = parseGeo(value.geo);
  if (value.wifi !== undefined) payload.wifi = parseWifi(value.wifi);
  if (value.bluetooth !== undefined) payload.bluetooth = parseBluetooth(value.bluetooth);
  return payload;
}

export interface DeviceKeyRecord { keyId: string; publicKeySpki: string; surface: Surface }
/**
 * Checks the evidence's signature with `device` (an active trusted device, or
 * the candidate key of a device.add change), then parses the payload. Binding
 * to the challenge is checked by the policy (checkDeviceBinding).
 */
export function verifyDeviceEvidence(evidence: unknown, device: DeviceKeyRecord): DevicePayloadV1 {
  if (!hasOnlyKeys(evidence, ['keyId', 'payload', 'signature'])) throw new DeviceCheckError('The device evidence is malformed.');
  const value = evidence as unknown as DeviceEvidence;
  if (value.keyId !== device.keyId) throw new DeviceCheckError("This device isn't trusted for this vault yet.");
  const bytes = fromBase64Url(value.payload, { min: 2, max: PAYLOAD_MAX_BYTES });
  if (!bytes) throw new DeviceCheckError('The device reading is missing or too large.');
  const signature = fromBase64Url(value.signature, { exact: 64 });
  if (!signature) throw new DeviceCheckError('The device signature is malformed.');
  const { key, spki } = importDeviceKey(device.publicKeySpki);
  if (keyIdOf(spki) !== device.keyId) throw new DeviceCheckError("This device isn't trusted for this vault yet.");
  let valid = false;
  try { valid = verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, signature); } catch { valid = false; }
  if (!valid) throw new DeviceCheckError('The device signature does not verify.');
  return parseDevicePayload(bytes);
}
