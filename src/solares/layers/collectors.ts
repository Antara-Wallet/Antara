/**
 * Readings and passkey ceremonies for vault protection layers (docs/VAULT_LAYERS.md
 * section 12, "Collector details"). Every collector fails closed: a missing API, a
 * refused permission, a timeout or an incomplete value stops the flow with a message
 * and nothing is sent. Desktop uses the native commands (section 10) through
 * src/platform/native.ts; the extension and the web use browser APIs.
 */
import { assertReading, bluetoothMatchId } from './evidence';
import { LAYER_NAMES, SURFACE_NOTES } from './claims';
import {
  MAX_BLUETOOTH_DEVICES,
  type AuthenticationResponseJSON, type BluetoothMatch, type BluetoothReading, type GeoReading, type LayerCapabilities, type LayerId,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON, type WifiReading,
} from './types';

export interface NativeWifiConnection { ssid: string; ssidHex: string; bssid: string }
export interface NativeBluetoothDevice { id: string; name: string; kind: 'classic' | 'le' }
export interface NativeLocation { lat: number; lng: number; accuracyM: number; at: number }
interface BluetoothDeviceLike { id: string; name?: string | null }
interface BluetoothLike { requestDevice(options: { filters: { name: string }[] } | { acceptAllDevices: true }): Promise<BluetoothDeviceLike> }
interface GeolocationLike { getCurrentPosition(success: (position: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }) => void, failure: (error: { code: number }) => void, options: PositionOptions): void }

/** Everything the collectors touch, injected so tests never need a real device. */
export interface LayerPlatform {
  capabilities(): LayerCapabilities;
  openWalletTab(route: `#${string}`): Promise<boolean>;
  native: {
    wifiConnections(): Promise<NativeWifiConnection[]>;
    connectedBluetooth(): Promise<NativeBluetoothDevice[]>;
    location(): Promise<NativeLocation>;
    passkeyGet(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
    passkeyCreate(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
    openLocationSettings(): Promise<void>;
  };
  browser: {
    geolocation(): GeolocationLike | undefined;
    bluetooth(): BluetoothLike | undefined;
    startAuthentication(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
    startRegistration(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  };
  now(): number;
}

export type CollectionAction = 'open-location-settings' | 'add-device' | 'open-full-tab' | 'add-passkey';
/**
 * A reading or ceremony that could not be completed. Nothing was sent.
 * `capture` marks a failure to capture the new item a change adds (a passkey being created, a Bluetooth
 * device or Wi-Fi network being chosen), not a failure to prove a layer that is already on. Only the
 * latter may lead to an offer to waive that layer (a 7-day recovery).
 */
export class LayerCollectionError extends Error {
  constructor(readonly layer: LayerId | 'device', message: string, readonly action: CollectionAction | null = null, readonly capture = false) {
    super(message); this.name = 'LayerCollectionError';
  }
}

const NATIVE_CODES = ['unsupported-platform', 'location-consent-required', 'wifi-unavailable', 'not-connected', 'bluetooth-unavailable', 'location-unavailable',
  'accuracy-unknown', 'invalid-request', 'passkey-cancelled', 'passkey-failed'] as const;
type NativeCode = typeof NATIVE_CODES[number];
/** The native wrappers throw NativeLayerError with a `code`; anything else is an unknown failure. */
function nativeCode(failure: unknown): NativeCode | null {
  const code = failure && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' && (NATIVE_CODES as readonly string[]).includes(code) ? code as NativeCode : null;
}
const NATIVE_MESSAGES: Record<NativeCode, string> = {
  'unsupported-platform': 'This check is not available on this device.',
  'location-consent-required': 'Allow location access for ANTARA in Windows Settings, then try again.',
  'wifi-unavailable': 'Wi-Fi is not available on this computer.',
  'not-connected': 'This computer is not connected to Wi-Fi.',
  'bluetooth-unavailable': 'Bluetooth is off or unavailable on this computer.',
  // Includes a fix this computer did not measure: the Windows default location, an IP-based or coarse location, or one over Remote Desktop.
  'location-unavailable': 'Windows could not give a location measured by this computer (its default, IP-based or Remote Desktop location is not used). Turn on Wi-Fi or GPS and try again.',
  'accuracy-unknown': 'Windows did not report how accurate the location is, so it cannot be used.',
  'invalid-request': 'ANTARA could not start the passkey prompt. Nothing was approved.',
  'passkey-cancelled': 'The passkey prompt was cancelled or timed out. Nothing was approved.',
  'passkey-failed': 'The passkey check did not complete. Nothing was approved.',
};

/** A slow or silent browser API or native command is a failure, never a pass. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); })]).finally(() => clearTimeout(timer));
}
/**
 * Client-side limits for the native commands (section 10), so a hung WinRT or Win32 call cannot leave a panel
 * busy until the page reloads. Location waits up to 60 s for the Windows consent prompt plus 20 s for a fix.
 * The command may still finish later; its result is then ignored and nothing is sent.
 */
export const NATIVE_TIMEOUT_MS = { location: 90_000, wifi: 20_000, bluetooth: 20_000 } as const;
/** Passkey prompts get the server's own timeout (30 to 180 s) plus this margin. */
export const PASSKEY_TIMEOUT_MARGIN_MS = 15_000;

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 };
/** The device's current location. Non-finite values, or an accuracy that is missing or not above zero, are refused. */
export async function collectGeo(platform: LayerPlatform): Promise<GeoReading> {
  const capabilities = platform.capabilities();
  let reading: GeoReading;
  if (capabilities.geolocation === 'native') {
    let location: NativeLocation;
    try { location = await withTimeout(platform.native.location(), NATIVE_TIMEOUT_MS.location, () => new LayerCollectionError('geolocation', 'Windows did not report this computer’s location in time. Try again.')); }
    catch (failure) {
      if (failure instanceof LayerCollectionError) throw failure;
      const code = nativeCode(failure);
      throw new LayerCollectionError('geolocation', code ? NATIVE_MESSAGES[code] : 'This computer’s location could not be read.', code === 'location-consent-required' ? 'open-location-settings' : null);
    }
    reading = { lat: location.lat, lng: location.lng, accuracyM: location.accuracyM, at: location.at, source: 'windows-location' };
  } else if (capabilities.geolocation === 'browser') {
    const api = platform.browser.geolocation();
    if (!api) throw new LayerCollectionError('geolocation', 'Location is not available in this browser.');
    const position = await withTimeout(new Promise<{ coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }>((resolve, reject) => {
      try {
        api.getCurrentPosition(resolve, error => reject(new LayerCollectionError('geolocation',
          error.code === 1 ? 'Location access is blocked for ANTARA. Allow it in your browser’s site settings and try again.'
            : error.code === 3 ? 'Finding your location timed out. Try again.' : 'Your location is not available right now.')), GEO_OPTIONS);
      } catch { reject(new LayerCollectionError('geolocation', 'Location is not available in this browser.')); }
    }), 20_000, () => new LayerCollectionError('geolocation', 'Finding your location timed out. Try again.'));
    reading = { lat: position.coords.latitude, lng: position.coords.longitude, accuracyM: position.coords.accuracy, at: position.timestamp, source: 'browser-geolocation' };
  } else throw new LayerCollectionError('geolocation', 'Location is not available on this device.');
  try { assertReading(capabilities.surface, 'geo', reading); }
  catch { throw new LayerCollectionError('geolocation', 'Your device did not report a complete location (with its accuracy), so it cannot be used.'); }
  return reading;
}

const BSSID = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const SSID_HEX = /^(?:[0-9a-f]{2}){1,32}$/;
/** ANTARA Desktop only: the Wi-Fi networks this computer is connected to. Only the SSID bytes and BSSID are sent. */
export async function collectWifi(platform: LayerPlatform): Promise<WifiReading & { names: string[] }> {
  const capabilities = platform.capabilities();
  if (!capabilities.wifiRadio || capabilities.surface !== 'desktop') throw new LayerCollectionError('wifi', SURFACE_NOTES.wifiRadioDesktopOnly);
  let connections: NativeWifiConnection[];
  try { connections = await withTimeout(platform.native.wifiConnections(), NATIVE_TIMEOUT_MS.wifi, () => new LayerCollectionError('wifi', 'Windows did not report the Wi-Fi connection in time. Try again.')); }
  catch (failure) {
    if (failure instanceof LayerCollectionError) throw failure;
    const code = nativeCode(failure);
    throw new LayerCollectionError('wifi', code === 'location-consent-required' ? SURFACE_NOTES.wifiConsent : code ? NATIVE_MESSAGES[code] : 'The Wi-Fi connection could not be read.',
      code === 'location-consent-required' ? 'open-location-settings' : null);
  }
  const valid = connections.filter(item => SSID_HEX.test(item.ssidHex) && BSSID.test(item.bssid));
  if (!valid.length || valid.length !== connections.length) throw new LayerCollectionError('wifi', 'This computer is not connected to Wi-Fi.');
  const reading: WifiReading = { connections: valid.map(({ ssidHex, bssid }) => ({ ssidHex, bssid })), at: platform.now(), source: 'windows-wlan' };
  assertReading('desktop', 'wifi', reading);
  return { ...reading, names: valid.map(item => item.ssid) };
}

const CLASSIC = /^[0-9A-F]{12}$/;
const classicId = (value: string) => value.replace(/[:-]/g, '').toUpperCase();
/** ANTARA Desktop: connected classic Bluetooth devices, for choosing one at enrollment. */
export async function connectedBluetoothDevices(platform: LayerPlatform): Promise<{ identifier: string; name: string }[]> {
  let devices: NativeBluetoothDevice[];
  try { devices = await withTimeout(platform.native.connectedBluetooth(), NATIVE_TIMEOUT_MS.bluetooth, () => new LayerCollectionError('bluetooth', 'Windows did not list the connected Bluetooth devices in time. Try again.')); }
  catch (failure) {
    if (failure instanceof LayerCollectionError) throw failure;
    const code = nativeCode(failure);
    throw new LayerCollectionError('bluetooth', code ? NATIVE_MESSAGES[code] : 'Bluetooth devices could not be read.');
  }
  return devices.filter(device => device.kind === 'classic' && CLASSIC.test(classicId(device.id)))
    .map(device => ({ identifier: classicId(device.id), name: (device.name || '').slice(0, 64) }));
}

/**
 * ANTARA Desktop: which connected devices are enrolled. The server sends each enrolled Desktop device only as an
 * opaque id bound to the challenge nonce (bluetoothMatchId), never its hardware address, so each connected
 * device's id is computed here and compared.
 */
export async function trustedDesktopDevices<T extends { identifier: string }>(match: BluetoothMatch[], nonce: string, devices: T[]): Promise<T[]> {
  const enrolled = new Set(match.filter(item => item.surface === 'desktop' && item.source === 'windows-classic').map(item => item.identifier));
  const trusted: T[] = [];
  for (const device of devices) if (enrolled.has(await bluetoothMatchId(nonce, device.identifier))) trusted.push(device);
  return trusted;
}

/**
 * Release or loosening check: shows Chrome's chooser filtered to your trusted devices (needs the button click),
 * or on Desktop lists only the connected devices that are enrolled. The full device list is never sent.
 */
export async function collectBluetoothMatch(platform: LayerPlatform, match: BluetoothMatch[], nonce: string): Promise<BluetoothReading> {
  const capabilities = platform.capabilities();
  const mine = match.filter(item => item.surface === capabilities.surface);
  if (!mine.length) throw new LayerCollectionError('bluetooth', `No trusted Bluetooth device is set up for ${capabilities.surface === 'desktop' ? 'ANTARA Desktop' : 'this browser'}. ${SURFACE_NOTES.bluetoothPerSurface}`);
  if (capabilities.bluetooth === 'native') {
    const found = await trustedDesktopDevices(mine, nonce, await connectedBluetoothDevices(platform));
    if (!found.length) throw new LayerCollectionError('bluetooth', 'Your trusted Bluetooth device is not connected to this computer. Connect it in Windows Bluetooth settings and try again.');
    const reading: BluetoothReading = { devices: found, at: platform.now(), source: 'windows-classic' };
    assertReading('desktop', 'bluetooth', reading);
    return reading;
  }
  if (capabilities.bluetooth !== 'web-bluetooth') throw new LayerCollectionError('bluetooth', 'Bluetooth is not available here. Use Chrome or Edge, or ANTARA Desktop.');
  const names = [...new Set(mine.map(item => item.name).filter(Boolean))];
  if (!names.length) throw new LayerCollectionError('bluetooth', 'Your trusted Bluetooth device has no name Chrome can look for. Add it again.');
  const device = await requestWebBluetooth(platform, { filters: names.map(name => ({ name })) });
  if (!mine.some(item => item.identifier === device.identifier)) throw new LayerCollectionError('bluetooth', 'That is not your trusted Bluetooth device. Nothing was approved.');
  const reading: BluetoothReading = { devices: [device], at: platform.now(), source: 'web-bluetooth' };
  assertReading(capabilities.surface, 'bluetooth', reading);
  return reading;
}

/** Enrollment while Bluetooth is off: exactly one device. On Desktop the user picked it from `connectedBluetoothDevices`; in Chrome from the chooser. */
export async function collectBluetoothChoice(platform: LayerPlatform, desktopChoice: string | null): Promise<BluetoothReading> {
  const capabilities = platform.capabilities();
  if (capabilities.bluetooth === 'native') {
    const device = (await connectedBluetoothDevices(platform)).find(item => item.identifier === desktopChoice);
    if (!device) throw new LayerCollectionError('bluetooth', 'Choose a Bluetooth device that is connected to this computer.', null, true);
    const reading: BluetoothReading = { devices: [device], at: platform.now(), source: 'windows-classic' };
    assertReading('desktop', 'bluetooth', reading);
    return reading;
  }
  if (capabilities.bluetooth !== 'web-bluetooth') throw new LayerCollectionError('bluetooth', 'Bluetooth is not available here. Use Chrome or Edge, or ANTARA Desktop.', null, true);
  const device = await requestWebBluetooth(platform, { acceptAllDevices: true }, true);
  if (!device.name) throw new LayerCollectionError('bluetooth', 'This device does not share a name, so Chrome could not find it again later. Choose another device.', null, true);
  const reading: BluetoothReading = { devices: [device], at: platform.now(), source: 'web-bluetooth' };
  assertReading(capabilities.surface, 'bluetooth', reading);
  return reading;
}

/**
 * Adding a Bluetooth device while Bluetooth is on (a loosening, section 8.1): one signed reading carries the
 * enrolled device(s) that prove the layer and exactly one device that is not trusted yet.
 * - Desktop reads the connected devices once: the enrolled ones that are connected, plus the one the user picked.
 * - Chrome needs a click per chooser, so the trusted device is checked first (`matched`, from collectBluetoothMatch
 *   on an earlier click) and the new device is chosen on this one.
 */
export async function collectBluetoothAddition(platform: LayerPlatform, match: BluetoothMatch[], nonce: string, desktopChoice: string | null, matched: BluetoothReading | null): Promise<BluetoothReading> {
  const capabilities = platform.capabilities();
  const mine = match.filter(item => item.surface === capabilities.surface);
  const trusted = (identifier: string) => mine.some(item => item.identifier === identifier);
  if (!mine.length) throw new LayerCollectionError('bluetooth', `No trusted Bluetooth device is set up for ${capabilities.surface === 'desktop' ? 'ANTARA Desktop' : 'this browser'}. ${SURFACE_NOTES.bluetoothPerSurface}`);
  if (capabilities.bluetooth === 'native') {
    const connected = await connectedBluetoothDevices(platform);
    const proof = await trustedDesktopDevices(mine, nonce, connected);
    if (!proof.length) throw new LayerCollectionError('bluetooth', 'Your trusted Bluetooth device is not connected to this computer. Connect it in Windows Bluetooth settings and try again.');
    const added = connected.find(device => device.identifier === desktopChoice);
    if (!added || proof.includes(added)) throw new LayerCollectionError('bluetooth', 'Choose a connected Bluetooth device that is not trusted yet.', null, true);
    const reading: BluetoothReading = { devices: [...proof.slice(0, MAX_BLUETOOTH_DEVICES - 1), added], at: platform.now(), source: 'windows-classic' };
    assertReading('desktop', 'bluetooth', reading);
    return reading;
  }
  if (capabilities.bluetooth !== 'web-bluetooth') throw new LayerCollectionError('bluetooth', 'Bluetooth is not available here. Use Chrome or Edge, or ANTARA Desktop.');
  if (!matched || matched.source !== 'web-bluetooth' || !matched.devices.length || !matched.devices.every(device => trusted(device.identifier))) {
    throw new LayerCollectionError('bluetooth', 'Check your trusted Bluetooth device first, then choose the new one.');
  }
  const device = await requestWebBluetooth(platform, { acceptAllDevices: true }, true);
  if (!device.name) throw new LayerCollectionError('bluetooth', 'This device does not share a name, so Chrome could not find it again later. Choose another device.', null, true);
  if (trusted(device.identifier)) throw new LayerCollectionError('bluetooth', 'That device is already trusted. Choose the device you want to add.', null, true);
  // The reading is as old as its first part: the trusted device was found on the earlier click.
  const reading: BluetoothReading = { devices: [...matched.devices, device], at: matched.at, source: 'web-bluetooth' };
  assertReading(capabilities.surface, 'bluetooth', reading);
  return reading;
}

async function requestWebBluetooth(platform: LayerPlatform, options: { filters: { name: string }[] } | { acceptAllDevices: true }, capture = false) {
  const api = platform.browser.bluetooth();
  if (!api || typeof api.requestDevice !== 'function') throw new LayerCollectionError('bluetooth', 'Bluetooth is not available in this browser. Use Chrome or Edge, or ANTARA Desktop.', null, capture);
  let device: BluetoothDeviceLike;
  try { device = await api.requestDevice(options); }
  catch (failure) {
    const name = failure && typeof failure === 'object' ? (failure as { name?: unknown }).name : undefined;
    throw new LayerCollectionError('bluetooth', name === 'NotFoundError' ? 'No Bluetooth device was chosen. Nothing was sent.'
      : name === 'SecurityError' || name === 'NotAllowedError' ? 'Bluetooth is not allowed here. Click the button again, or check your browser’s Bluetooth permission.'
      : 'Bluetooth could not be used. Check that Bluetooth is on.', null, capture);
  }
  const identifier = typeof device?.id === 'string' ? device.id : '';
  if (!identifier || identifier.length > 64) throw new LayerCollectionError('bluetooth', 'The browser returned an unusable Bluetooth device.', null, capture);
  return { identifier, name: typeof device.name === 'string' ? device.name.slice(0, 64) : '' };
}

/** `capture`: the failure was in creating a new passkey, not in using an enrolled one (never a reason to waive Biometrics). */
function passkeyFailure(failure: unknown, capture: boolean): LayerCollectionError {
  if (failure instanceof LayerCollectionError) return failure;
  const code = nativeCode(failure);
  if (code) return new LayerCollectionError('biometrics', NATIVE_MESSAGES[code], null, capture);
  const name = failure && typeof failure === 'object' ? (failure as { name?: unknown; code?: unknown }).name : undefined;
  if (name === 'NotAllowedError' || name === 'AbortError') return new LayerCollectionError('biometrics', NATIVE_MESSAGES['passkey-cancelled'], null, capture);
  if (name === 'InvalidStateError') return new LayerCollectionError('biometrics', 'This passkey is already added to your vault.', null, capture);
  if (name === 'SecurityError') return new LayerCollectionError('biometrics', 'This app is not allowed to use ANTARA passkeys here.', null, capture);
  return new LayerCollectionError('biometrics', NATIVE_MESSAGES['passkey-failed'], null, capture);
}
/** The server's passkey timeout (parsed to 30..180 s) plus a margin, so a prompt that never returns still ends the step. */
const passkeyLimit = (timeout: number | undefined) => (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 180_000) : 120_000) + PASSKEY_TIMEOUT_MARGIN_MS;

/** Last step of a release: your device verifies you (user verification required) and signs the challenge. */
export async function collectPasskey(platform: LayerPlatform, options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  const mode = platform.capabilities().passkey;
  if (mode === 'none') throw new LayerCollectionError('biometrics', 'Passkeys are not available here.');
  if (options.userVerification !== 'required') throw new LayerCollectionError('biometrics', NATIVE_MESSAGES['invalid-request']);
  try {
    return await withTimeout(mode === 'native' ? platform.native.passkeyGet(options) : platform.browser.startAuthentication(options), passkeyLimit(options.timeout),
      () => new LayerCollectionError('biometrics', NATIVE_MESSAGES['passkey-cancelled']));
  } catch (failure) { throw passkeyFailure(failure, false); }
}

/** passkey.add: creates the new passkey. Every failure here is a capture failure, never a reason to waive Biometrics. */
export async function createPasskey(platform: LayerPlatform, options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  const mode = platform.capabilities().passkey;
  if (mode === 'none') throw new LayerCollectionError('biometrics', 'Passkeys are not available here.', null, true);
  if (options.authenticatorSelection?.userVerification !== 'required' || options.attestation !== 'none') throw new LayerCollectionError('biometrics', NATIVE_MESSAGES['invalid-request'], null, true);
  try {
    return await withTimeout(mode === 'native' ? platform.native.passkeyCreate(options) : platform.browser.startRegistration(options), passkeyLimit(options.timeout),
      () => new LayerCollectionError('biometrics', NATIVE_MESSAGES['passkey-cancelled'], null, true));
  } catch (failure) { throw passkeyFailure(failure, true); }
}

/** A readable label for a collection failure, naming the layer. */
export const collectionTitle = (error: LayerCollectionError) => error.layer === 'device' ? 'This device' : LAYER_NAMES[error.layer];
