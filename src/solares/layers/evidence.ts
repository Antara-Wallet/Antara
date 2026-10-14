/**
 * Evidence building for vault protection layers (docs/VAULT_LAYERS.md section 6).
 * The client never computes the release or change digest: it echoes the server's,
 * after checking that the release the server describes is the one on this device.
 */
import {
  MAX_BLUETOOTH_DEVICES, MAX_DEVICE_PAYLOAD_BYTES, READING_SOURCES,
  type BluetoothReading, type DevicePayloadV1, type GeoReading, type ReleaseSummary, type Surface, type WifiReading,
} from './types';

const BASE64URL = /^[A-Za-z0-9_-]*$/;
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error('Invalid base64url value.');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error('Invalid hex value.');
  return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16));
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error('This browser cannot create the signatures vault layers need.');
  return value;
}
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bytes as BufferSource));
}

/**
 * webauthnChallenge(kind) = base64url(SHA256(UTF-8("ANTARA vault layers v1 " + kind) || 0x00 || nonce || digest)), section 6.2.
 * The client recomputes it so a passkey prompt is only ever answered for the nonce and digest this device also echoes.
 */
export async function webauthnChallenge(kind: 'get' | 'create', nonce: string, digest: string): Promise<string> {
  const nonceBytes = base64UrlDecode(nonce), digestBytes = fromHex(digest);
  if (nonceBytes.length !== 32 || digestBytes.length !== 32) throw new Error('Invalid challenge.');
  const label = new TextEncoder().encode(`ANTARA vault layers v1 ${kind}`);
  const input = new Uint8Array(label.length + 1 + 64);
  input.set(label, 0); input[label.length] = 0; input.set(nonceBytes, label.length + 1); input.set(digestBytes, label.length + 33);
  return base64UrlEncode(await sha256(input));
}

/**
 * The opaque id a begin answer carries for an enrolled Desktop (windows-classic) Bluetooth device, so the
 * stored hardware address is never sent to the client (section 9.2):
 * uppercase hex of the first 6 bytes of SHA256(UTF-8("ANTARA bluetooth match v1") || 0x00 || nonce(32) || UTF-8(identifier)).
 * ANTARA Desktop computes it for each connected device and signs only the raw identifiers that match.
 */
export async function bluetoothMatchId(nonce: string, identifier: string): Promise<string> {
  const nonceBytes = base64UrlDecode(nonce);
  if (nonceBytes.length !== 32) throw new Error('Invalid challenge.');
  const label = new TextEncoder().encode('ANTARA bluetooth match v1'), id = new TextEncoder().encode(identifier);
  const input = new Uint8Array(label.length + 1 + 32 + id.length);
  input.set(label, 0); input[label.length] = 0; input.set(nonceBytes, label.length + 1); input.set(id, label.length + 33);
  return toHex((await sha256(input)).subarray(0, 6)).toUpperCase();
}

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const BSSID = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const SSID_HEX = /^(?:[0-9a-f]{2}){1,32}$/;
const BLUETOOTH_CLASSIC = /^[0-9A-F]{12}$/;

/** Throws unless a reading is well formed and allowed from this surface (section 6.3 field rules). */
export function assertReading(surface: Surface, name: 'geo', reading: GeoReading): void;
export function assertReading(surface: Surface, name: 'wifi', reading: WifiReading): void;
export function assertReading(surface: Surface, name: 'bluetooth', reading: BluetoothReading): void;
export function assertReading(surface: Surface, name: 'geo' | 'wifi' | 'bluetooth', reading: GeoReading | WifiReading | BluetoothReading) {
  const sources = READING_SOURCES[surface];
  if (!finite(reading.at) || reading.at <= 0) throw new Error('A reading has no valid time.');
  if (name === 'geo') {
    const geo = reading as GeoReading;
    if (geo.source !== sources.geo || !finite(geo.lat) || !finite(geo.lng) || !finite(geo.accuracyM) || geo.lat < -90 || geo.lat > 90 || geo.lng < -180 || geo.lng > 180 || geo.accuracyM <= 0) {
      throw new Error('The location reading is incomplete, so it cannot be used.');
    }
  } else if (name === 'wifi') {
    const wifi = reading as WifiReading;
    if (!sources.wifi || wifi.source !== sources.wifi) throw new Error('Wi-Fi readings can only come from ANTARA Desktop.');
    if (!wifi.connections.length || wifi.connections.length > 8 || wifi.connections.some(item => !SSID_HEX.test(item.ssidHex) || !BSSID.test(item.bssid))) {
      throw new Error('The Wi-Fi reading is incomplete, so it cannot be used.');
    }
  } else {
    const bluetooth = reading as BluetoothReading;
    if (bluetooth.source !== sources.bluetooth || !bluetooth.devices.length || bluetooth.devices.length > MAX_BLUETOOTH_DEVICES) throw new Error('The Bluetooth reading is incomplete, so it cannot be used.');
    for (const device of bluetooth.devices) {
      const valid = bluetooth.source === 'windows-classic' ? BLUETOOTH_CLASSIC.test(device.identifier) : device.identifier.length > 0 && device.identifier.length <= 64;
      if (!valid || typeof device.name !== 'string' || device.name.length > 64) throw new Error('The Bluetooth reading is incomplete, so it cannot be used.');
    }
  }
}

export interface DevicePayloadInput {
  purpose: 'release' | 'change';
  challengeId: string;
  nonce: string;
  digest: string;
  keyId: string;
  surface: Surface;
  signedAt: number;
  geo?: GeoReading;
  wifi?: WifiReading;
  bluetooth?: BluetoothReading;
}

/** DevicePayloadV1 with exactly the section 6.3 field set and order. Readings that are not passed are omitted. */
export function buildDevicePayload(input: DevicePayloadInput): DevicePayloadV1 {
  if (!finite(input.signedAt)) throw new Error('The device clock is unavailable.');
  const payload: DevicePayloadV1 = {
    v: 1, purpose: input.purpose, challengeId: input.challengeId, nonce: input.nonce, digest: input.digest,
    keyId: input.keyId, surface: input.surface, signedAt: input.signedAt,
  };
  if (input.geo) {
    assertReading(input.surface, 'geo', input.geo);
    const { lat, lng, accuracyM, at, source } = input.geo;
    payload.geo = { lat, lng, accuracyM, at, source };
  }
  if (input.wifi) {
    assertReading(input.surface, 'wifi', input.wifi);
    payload.wifi = { connections: input.wifi.connections.map(({ ssidHex, bssid }) => ({ ssidHex, bssid })), at: input.wifi.at, source: input.wifi.source };
  }
  if (input.bluetooth) {
    assertReading(input.surface, 'bluetooth', input.bluetooth);
    payload.bluetooth = { devices: input.bluetooth.devices.map(({ identifier, name }) => ({ identifier, name })), at: input.bluetooth.at, source: input.bluetooth.source };
  }
  return payload;
}

/** The exact bytes that are signed and sent (base64url of these bytes). */
export function encodeDevicePayload(payload: DevicePayloadV1): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > MAX_DEVICE_PAYLOAD_BYTES) throw new Error('The device reading is too large to send.');
  return bytes;
}

/**
 * Section 12 step 3: the release the server will approve must be the one this device read from Solana.
 * Any difference aborts before any prompt.
 */
export function assertReleaseMatches(server: ReleaseSummary, device: ReleaseSummary): void {
  const same = server.multisig === device.multisig && server.transactionIndex === device.transactionIndex && server.asset === device.asset &&
    server.amountRaw === device.amountRaw && server.recipient === device.recipient;
  if (!same) throw new Error('The server described a different release. Nothing was approved.');
}
