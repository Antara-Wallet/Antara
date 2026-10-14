// Typed wrappers over ANTARA Desktop's vault-layer commands (docs/VAULT_LAYERS.md
// §10 and §11). Tauri is imported dynamically, like the opener, so web and
// extension pages never reach it. Every wrapper checks the Rust output against
// the contract exactly: an unknown field, an empty string, a non-finite number or
// a malformed identifier throws a NativeLayerError. A reading is never defaulted
// or repaired, so a layer that cannot be read fails closed.
//
// These are readings for ANTARA's server to judge. Passing them here proves
// nothing: the server verifies signatures, zones, networks and devices.
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { isTauri } from './index';

export type NativeErrorCode = 'unsupported-platform' | 'location-consent-required' | 'wifi-unavailable' | 'not-connected'
  | 'bluetooth-unavailable' | 'location-unavailable' | 'accuracy-unknown' | 'invalid-request' | 'passkey-cancelled' | 'passkey-failed';

const MESSAGES: Record<NativeErrorCode, string> = {
  'unsupported-platform': 'This check needs ANTARA Desktop on Windows.',
  'location-consent-required': 'Windows is not sharing location with desktop apps. Allow it in Windows Settings > Privacy & security > Location (Windows 11 treats Wi-Fi names as location data).',
  'wifi-unavailable': 'ANTARA Desktop could not read Wi-Fi on this computer. Check that Wi-Fi is turned on.',
  'not-connected': 'This computer is not connected to a Wi-Fi network.',
  'bluetooth-unavailable': 'ANTARA Desktop could not read Bluetooth on this computer. Check that Bluetooth is turned on.',
  'location-unavailable': "ANTARA Desktop could not read a location this computer measured. The Windows default location, an IP-based or coarse location, and one over Remote Desktop are not used.",
  'accuracy-unknown': 'Windows did not report how accurate this location is, so ANTARA cannot use it.',
  'invalid-request': 'ANTARA refused a malformed passkey request. Nothing was signed.',
  'passkey-cancelled': 'The passkey prompt was cancelled or timed out.',
  'passkey-failed': 'Windows could not complete the passkey request.',
};

export class NativeLayerError extends Error {
  constructor(readonly code: NativeErrorCode, message: string) {
    super(message);
    this.name = 'NativeLayerError';
  }
}

export interface NativeWifiConnection { ssid: string; ssidHex: string; bssid: string }
export interface NativeBluetoothDevice { id: string; name: string; kind: 'classic' | 'le' }
export interface NativeLocation { lat: number; lng: number; accuracyM: number; at: number }

function nativeError(code: NativeErrorCode, message = MESSAGES[code]): NativeLayerError {
  return new NativeLayerError(code, message);
}

// Error codes each command may return (§10). Anything else, including Tauri's own
// "not allowed" or "not found" errors from an older build, maps to the fallback.
const COMMANDS = {
  layer_wifi_connections: { fallback: 'wifi-unavailable', codes: ['location-consent-required', 'wifi-unavailable', 'not-connected', 'unsupported-platform'] },
  layer_bluetooth_connected: { fallback: 'bluetooth-unavailable', codes: ['bluetooth-unavailable', 'unsupported-platform'] },
  layer_location: { fallback: 'location-unavailable', codes: ['location-consent-required', 'location-unavailable', 'accuracy-unknown', 'unsupported-platform'] },
  layer_passkey_get: { fallback: 'passkey-failed', codes: ['invalid-request', 'passkey-cancelled', 'passkey-failed', 'unsupported-platform'] },
  layer_passkey_create: { fallback: 'passkey-failed', codes: ['invalid-request', 'passkey-cancelled', 'passkey-failed', 'unsupported-platform'] },
  // §10 lists only unsupported-platform; the Windows command also answers
  // location-unavailable when Windows does not open the settings page.
  open_location_settings: { fallback: 'location-unavailable', codes: ['location-unavailable', 'unsupported-platform'] },
} as const satisfies Record<string, { fallback: NativeErrorCode; codes: readonly NativeErrorCode[] }>;

type LayerCommand = keyof typeof COMMANDS;

async function invokeLayer(command: LayerCommand, args?: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw nativeError('unsupported-platform');
  let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    throw nativeError('unsupported-platform');
  }
  const { fallback, codes } = COMMANDS[command];
  try {
    return await invoke(command, args);
  } catch (cause) {
    const known = (codes as readonly string[]).includes(cause as string);
    throw nativeError(known ? cause as NativeErrorCode : fallback);
  }
}

// ---- JSON shape helpers ------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** A plain object with exactly `required` keys plus, optionally, `optional` keys. */
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return null;
  if (required.some(key => !keys.includes(key))) return null;
  return value as JsonObject;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Unpadded base64url whose decoded length is within [min, max] bytes. */
function isBase64Url(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is string {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return false;
  const bytes = Math.floor((value.length * 3) / 4);
  return bytes >= min && bytes <= max;
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Wi-Fi -------------------------------------------------------------------

const SSID_HEX = /^(?:[0-9a-fA-F]{2}){1,32}$/;
const BSSID = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const NOT_AN_ACCESS_POINT = new Set(['00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF']);
const MAX_WIFI_CONNECTIONS = 8;

/**
 * The Wi-Fi network(s) this computer is connected to (layer_wifi_connections).
 * ssidHex is the exact SSID bytes, lowercased; ssid is display text only.
 */
export async function nativeWifiConnections(): Promise<NativeWifiConnection[]> {
  const raw = await invokeLayer('layer_wifi_connections');
  const bad = () => nativeError('wifi-unavailable', 'ANTARA Desktop returned an unreadable Wi-Fi reading.');
  if (!Array.isArray(raw) || raw.length > MAX_WIFI_CONNECTIONS) throw bad();
  // The command reports "not-connected" itself; an empty list is never a match.
  if (raw.length === 0) throw nativeError('not-connected');
  return raw.map(item => {
    const entry = exactObject(item, ['ssid', 'ssidHex', 'bssid']);
    if (!entry) throw bad();
    const { ssid, ssidHex, bssid } = entry;
    if (typeof ssidHex !== 'string' || !SSID_HEX.test(ssidHex)) throw bad();
    // Lossy UTF-8 never yields more UTF-16 units than there are SSID bytes.
    if (typeof ssid !== 'string' || ssid.length === 0 || ssid.length > ssidHex.length / 2) throw bad();
    if (typeof bssid !== 'string' || !BSSID.test(bssid) || NOT_AN_ACCESS_POINT.has(bssid)) throw bad();
    return { ssid, ssidHex: ssidHex.toLowerCase(), bssid };
  });
}

// ---- Bluetooth ---------------------------------------------------------------

const BLUETOOTH_ADDRESS = /^[0-9A-F]{12}$/;
// The command's own enumeration bound (src-tauri/src/layers.rs MAX_BLUETOOTH_DEVICES).
const MAX_BLUETOOTH_DEVICES = 256;
// Win32 BLUETOOTH_DEVICE_INFO.szName is WCHAR[248]. Windows may report a connected
// device before its name is known, so an empty name is kept as reported, never invented.
const MAX_BLUETOOTH_NAME = 248;

/**
 * Bluetooth devices currently connected to this computer (layer_bluetooth_connected).
 * Remembered but disconnected devices are not listed; distance is not measured.
 */
export async function nativeConnectedBluetooth(): Promise<NativeBluetoothDevice[]> {
  const raw = await invokeLayer('layer_bluetooth_connected');
  const bad = () => nativeError('bluetooth-unavailable', 'ANTARA Desktop returned an unreadable Bluetooth reading.');
  if (!Array.isArray(raw) || raw.length > MAX_BLUETOOTH_DEVICES) throw bad();
  const seen = new Set<string>();
  return raw.map(item => {
    const entry = exactObject(item, ['id', 'name', 'kind']);
    if (!entry) throw bad();
    const { id, name, kind } = entry;
    if (typeof id !== 'string' || !BLUETOOTH_ADDRESS.test(id) || id === '000000000000' || seen.has(id)) throw bad();
    seen.add(id);
    if (typeof name !== 'string' || name.length > MAX_BLUETOOTH_NAME) throw bad();
    if (kind !== 'classic' && kind !== 'le') throw bad();
    return { id, name, kind };
  });
}

// ---- Location ----------------------------------------------------------------

/** One fresh WinRT position (layer_location). Unknown accuracy is an error, never 0. */
export async function nativeLocation(): Promise<NativeLocation> {
  const raw = await invokeLayer('layer_location');
  const bad = () => nativeError('location-unavailable', 'ANTARA Desktop returned an unreadable location reading.');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad();
  const accuracyM = (raw as JsonObject).accuracyM;
  if (!finite(accuracyM) || accuracyM <= 0) throw nativeError('accuracy-unknown');
  const entry = exactObject(raw, ['lat', 'lng', 'accuracyM', 'at']);
  if (!entry) throw bad();
  const { lat, lng, at } = entry;
  if (!finite(lat) || lat < -90 || lat > 90) throw bad();
  if (!finite(lng) || lng < -180 || lng > 180) throw bad();
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) throw bad();
  return { lat, lng, accuracyM, at };
}

// ---- Passkeys (webauthn.dll) -------------------------------------------------

/** clientDataJSON origin the Rust commands use for every ceremony (§10). */
export const NATIVE_PASSKEY_ORIGIN = 'https://tauri.localhost';
const RP_ID = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TIMEOUT_DEFAULT_MS = 120_000;
const TIMEOUT_MIN_MS = 30_000;
const TIMEOUT_MAX_MS = 180_000;
const MAX_CREDENTIALS = 16;
const CREDENTIAL_ID_MIN = 16;
const CREDENTIAL_ID_MAX = 1023;
const TRANSPORTS = new Set<string>(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const COSE_ES256 = -7;
const COSE_RS256 = -257;

type NativePasskeyGetRequest = { rpId: string; challenge: string; allowCredentials: string[]; timeoutMs: number };
type NativePasskeyCreateRequest = {
  rpId: string; rpName: string; challenge: string; userId: string; userName: string; userDisplayName: string;
  excludeCredentials: string[]; timeoutMs: number;
};

function invalidRequest(): NativeLayerError {
  return nativeError('invalid-request');
}

function timeoutOf(timeout: unknown): number {
  const value = timeout === undefined ? TIMEOUT_DEFAULT_MS : timeout;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TIMEOUT_MIN_MS || value > TIMEOUT_MAX_MS) throw invalidRequest();
  return value;
}

function credentialIds(descriptors: unknown, min: number): string[] {
  if (descriptors === undefined && min === 0) return [];
  if (!Array.isArray(descriptors) || descriptors.length < min || descriptors.length > MAX_CREDENTIALS) throw invalidRequest();
  return descriptors.map(descriptor => {
    const { id, type } = (descriptor ?? {}) as { id?: unknown; type?: unknown };
    if (type !== 'public-key' || !isBase64Url(id, CREDENTIAL_ID_MIN, CREDENTIAL_ID_MAX)) throw invalidRequest();
    return id;
  });
}

// Names shown in the Windows passkey dialog, as the command accepts them: 1 to 128
// characters, not blank, no control characters.
const MAX_DISPLAY_CHARS = 128;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function checkedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || [...value].length > MAX_DISPLAY_CHARS || CONTROL_CHARACTER.test(value)) {
    throw invalidRequest();
  }
  return value;
}

/** Native ceremonies always require user verification; a weaker server request is refused. */
function requireVerification(value: unknown) {
  if (value !== undefined && value !== 'required') throw invalidRequest();
}

function passkeyGetRequest(options: PublicKeyCredentialRequestOptionsJSON): NativePasskeyGetRequest {
  if (typeof options !== 'object' || options === null) throw invalidRequest();
  if (typeof options.rpId !== 'string' || !RP_ID.test(options.rpId)) throw invalidRequest();
  if (!isBase64Url(options.challenge, 32, 32)) throw invalidRequest();
  requireVerification(options.userVerification);
  return {
    rpId: options.rpId,
    challenge: options.challenge,
    allowCredentials: credentialIds(options.allowCredentials, 1),
    timeoutMs: timeoutOf(options.timeout),
  };
}

function passkeyCreateRequest(options: PublicKeyCredentialCreationOptionsJSON): NativePasskeyCreateRequest {
  if (typeof options !== 'object' || options === null || typeof options.rp !== 'object' || options.rp === null
    || typeof options.user !== 'object' || options.user === null) throw invalidRequest();
  if (typeof options.rp.id !== 'string' || !RP_ID.test(options.rp.id)) throw invalidRequest();
  if (!isBase64Url(options.challenge, 32, 32)) throw invalidRequest();
  if (!isBase64Url(options.user.id, 1, 64)) throw invalidRequest();
  requireVerification(options.authenticatorSelection?.userVerification);
  if (options.attestation !== undefined && options.attestation !== 'none') throw invalidRequest();
  // webauthn.dll is asked for ES256 and RS256 only; any other algorithm would be ignored.
  const algorithms = options.pubKeyCredParams;
  if (!Array.isArray(algorithms) || algorithms.length === 0
    || algorithms.some(param => param?.type !== 'public-key' || (param.alg !== COSE_ES256 && param.alg !== COSE_RS256))) throw invalidRequest();
  return {
    rpId: options.rp.id,
    rpName: checkedText(options.rp.name),
    challenge: options.challenge,
    userId: options.user.id,
    userName: checkedText(options.user.name),
    userDisplayName: checkedText(options.user.displayName),
    excludeCredentials: credentialIds(options.excludeCredentials, 0),
    timeoutMs: timeoutOf(options.timeout),
  };
}

/** clientDataJSON must be exactly what the Rust command builds for this ceremony. */
function checkClientData(value: unknown, type: 'webauthn.get' | 'webauthn.create', challenge: string): value is string {
  if (!isBase64Url(value, 2, 4096)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlBytes(value)));
  } catch {
    return false;
  }
  const data = exactObject(parsed, ['type', 'challenge', 'origin', 'crossOrigin']);
  return !!data && data.type === type && data.challenge === challenge && data.origin === NATIVE_PASSKEY_ORIGIN && data.crossOrigin === false;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/** authenticatorData starts with SHA-256(rpId) and flags; UP and UV must both be set. */
async function checkAuthenticatorData(value: unknown, rpId: string): Promise<boolean> {
  if (!isBase64Url(value, 37, 4096)) return false;
  const data = base64UrlBytes(value as string);
  if (data.length < 37) return false;
  const flags = data[32];
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) return false;
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  return expected.every((byte, index) => data[index] === byte);
}

const emptyObject = (value: unknown) => exactObject(value, []) !== null;

/**
 * Windows Hello (or a phone, through the system dialog) signs the server's
 * challenge with an enrolled passkey (layer_passkey_get). User verification is
 * always required. The assertion is checked for shape here and verified by the server.
 */
export async function nativePasskeyGet(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  const request = passkeyGetRequest(options);
  const raw = await invokeLayer('layer_passkey_get', { request });
  const bad = () => nativeError('passkey-failed', 'Windows returned an unreadable passkey response. Nothing was sent.');
  const entry = exactObject(raw, ['id', 'rawId', 'type', 'response', 'clientExtensionResults']);
  if (!entry) throw bad();
  const { id, rawId, type, response, clientExtensionResults } = entry;
  if (typeof id !== 'string' || id !== rawId || !request.allowCredentials.includes(id)) throw bad();
  if (type !== 'public-key' || !emptyObject(clientExtensionResults)) throw bad();
  const assertion = exactObject(response, ['clientDataJSON', 'authenticatorData', 'signature'], ['userHandle']);
  if (!assertion) throw bad();
  const { clientDataJSON, authenticatorData, signature, userHandle } = assertion;
  if (!checkClientData(clientDataJSON, 'webauthn.get', request.challenge)) throw bad();
  if (!await checkAuthenticatorData(authenticatorData, request.rpId)) throw bad();
  if (!isBase64Url(signature, 8, 1024)) throw bad();
  if (userHandle !== undefined && userHandle !== null && !isBase64Url(userHandle, 1, 64)) throw bad();
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData: authenticatorData as string,
      signature,
      ...(typeof userHandle === 'string' ? { userHandle } : {}),
    },
    clientExtensionResults: {},
  };
}

/**
 * Creates a passkey for the server's options (layer_passkey_create): attestation
 * none, user verification required, ES256 or RS256. The server verifies it.
 */
export async function nativePasskeyCreate(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  const request = passkeyCreateRequest(options);
  const raw = await invokeLayer('layer_passkey_create', { request });
  const bad = () => nativeError('passkey-failed', 'Windows returned an unreadable passkey response. Nothing was sent.');
  const entry = exactObject(raw, ['id', 'rawId', 'type', 'response', 'clientExtensionResults']);
  if (!entry) throw bad();
  const { id, rawId, type, response, clientExtensionResults } = entry;
  if (!isBase64Url(id, CREDENTIAL_ID_MIN, CREDENTIAL_ID_MAX) || id !== rawId || request.excludeCredentials.includes(id)) throw bad();
  if (type !== 'public-key' || !emptyObject(clientExtensionResults)) throw bad();
  const attestation = exactObject(response, ['clientDataJSON', 'attestationObject'], ['transports']);
  if (!attestation) throw bad();
  const { clientDataJSON, attestationObject, transports } = attestation;
  if (!checkClientData(clientDataJSON, 'webauthn.create', request.challenge)) throw bad();
  if (!isBase64Url(attestationObject, 37, 64 * 1024)) throw bad();
  if (transports !== undefined && (!Array.isArray(transports) || transports.length > TRANSPORTS.size
    || transports.some(transport => typeof transport !== 'string' || !TRANSPORTS.has(transport))
    || new Set(transports).size !== transports.length)) throw bad();
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      attestationObject,
      ...(transports !== undefined ? { transports: transports as AuthenticatorTransportFuture[] } : {}),
    },
    clientExtensionResults: {},
  };
}

const SETTINGS_NOT_OPENED = 'Windows did not open its location settings. Open Settings > Privacy & security > Location yourself.';

/** Opens Windows' location privacy settings. The URI is fixed in Rust; nothing is passed. */
export async function openLocationSettings(): Promise<void> {
  let raw: unknown;
  try {
    raw = await invokeLayer('open_location_settings');
  } catch (error) {
    if (error instanceof NativeLayerError && error.code === 'location-unavailable') throw nativeError('location-unavailable', SETTINGS_NOT_OPENED);
    throw error;
  }
  if (raw !== null && raw !== undefined) throw nativeError('location-unavailable', SETTINGS_NOT_OPENED);
}
