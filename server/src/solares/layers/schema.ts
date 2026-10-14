/**
 * Strict validation of stored layer configuration (vaultStore.ts, document
 * version 2). Run on every read: an unknown key, a wrong type, an empty item
 * list for an enabled layer or a duplicate id makes the whole store refuse,
 * so a damaged file can never look like "no layers".
 */
import { cleanLabel, fromBase64Url, hasOnlyKeys, isIsoTime } from './codec.js';
import { BSSID, CLASSIC_IDENTIFIER, SSID_HEX, WEB_BLUETOOTH_IDENTIFIER } from './device.js';
import { validLatLng, validRadius } from './geo.js';
import { normaliseCidr } from './network.js';
import { validSealedSecret } from './totp.js';
import {
  HISTORY_LIMIT, ITEM_LIMITS, LABEL_MAX, LAYER_IDS, MAX_PENDING_CHANGES, OPTIONAL_LAYER_IDS, SURFACES,
  type AppliedChangeOp, type BluetoothDeviceRecord, type ChangeHistoryEntry, type LedgerLayerPass, type PasskeyCredentialRecord, type PendingChange,
  type SafeZoneRecord, type TotpAuthenticatorRecord, type TrustedDeviceRecord, type TrustedNetworkRecord, type VaultLayerConfig, type WifiRadioRecord,
} from './types.js';

const RAW = /^[1-9]\d{0,30}$/;
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const CHANGE_ID = /^chg_[A-Za-z0-9_-]{16}$/;
const AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RP_ID = /^[a-z0-9.-]{1,253}$/;
const TRANSPORT = /^[a-z-]{1,16}$/;
const itemId = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{16}$`);
const ZONE_ID = itemId('zone'), NET_ID = itemId('net'), RADIO_ID = itemId('radio'), BT_ID = itemId('bt'), TOTP_ID = itemId('totp');

const isLabel = (value: unknown) => typeof value === 'string' && cleanLabel(value, LABEL_MAX) === value;
const isSurface = (value: unknown) => (SURFACES as readonly unknown[]).includes(value);
const isOptional = (value: unknown) => (OPTIONAL_LAYER_IDS as readonly unknown[]).includes(value);
const uniqueBy = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
const listOf = <T>(value: unknown, min: number, max: number, item: (entry: unknown) => entry is T): value is T[] =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(item);
/** Provenance of a passkey or trusted device: absent, or added by a recovery change. */
const validAddedVia = (value: unknown) => value === undefined || value === 'recovery';

export function validPasskey(value: unknown): value is PasskeyCredentialRecord {
  return hasOnlyKeys(value, ['id', 'publicKey', 'counter', 'rpId', 'transports', 'deviceType', 'backedUp', 'aaguid', 'surface', 'label', 'addedAt'], ['addedVia']) &&
    fromBase64Url(value.id, { min: 1, max: 1024 }) !== null && fromBase64Url(value.publicKey, { min: 16, max: 2048 }) !== null &&
    typeof value.counter === 'number' && Number.isInteger(value.counter) && value.counter >= 0 && value.counter <= 0xffffffff &&
    typeof value.rpId === 'string' && RP_ID.test(value.rpId) &&
    Array.isArray(value.transports) && value.transports.length <= 8 && value.transports.every(item => typeof item === 'string' && TRANSPORT.test(item)) &&
    (value.deviceType === 'singleDevice' || value.deviceType === 'multiDevice') && typeof value.backedUp === 'boolean' &&
    typeof value.aaguid === 'string' && AAGUID.test(value.aaguid) && isSurface(value.surface) && isLabel(value.label) && isIsoTime(value.addedAt) &&
    validAddedVia(value.addedVia);
}
export function validDevice(value: unknown): value is TrustedDeviceRecord {
  return hasOnlyKeys(value, ['keyId', 'publicKeySpki', 'surface', 'label', 'addedAt'], ['addedVia']) && typeof value.keyId === 'string' && KEY_ID.test(value.keyId) &&
    fromBase64Url(value.publicKeySpki, { min: 32, max: 200 }) !== null && isSurface(value.surface) && isLabel(value.label) && isIsoTime(value.addedAt) &&
    validAddedVia(value.addedVia);
}
export function validZone(value: unknown): value is SafeZoneRecord {
  return hasOnlyKeys(value, ['id', 'label', 'lat', 'lng', 'radiusM', 'addedAt']) && typeof value.id === 'string' && ZONE_ID.test(value.id) && isLabel(value.label) &&
    validLatLng(value.lat, value.lng) && validRadius(value.radiusM) && isIsoTime(value.addedAt);
}
export function validNetwork(value: unknown): value is TrustedNetworkRecord {
  return hasOnlyKeys(value, ['id', 'label', 'cidr', 'addedAt']) && typeof value.id === 'string' && NET_ID.test(value.id) && isLabel(value.label) &&
    typeof value.cidr === 'string' && normaliseCidr(value.cidr) === value.cidr && isIsoTime(value.addedAt);
}
export function validRadio(value: unknown): value is WifiRadioRecord {
  return hasOnlyKeys(value, ['id', 'label', 'ssid', 'ssidHex', 'bssids', 'addedAt']) && typeof value.id === 'string' && RADIO_ID.test(value.id) && isLabel(value.label) &&
    typeof value.ssid === 'string' && value.ssid.length <= 64 && typeof value.ssidHex === 'string' && SSID_HEX.test(value.ssidHex) &&
    listOf(value.bssids, 1, ITEM_LIMITS.bssids, (item): item is string => typeof item === 'string' && BSSID.test(item)) && uniqueBy(value.bssids, item => item) &&
    isIsoTime(value.addedAt);
}
export function validBluetooth(value: unknown): value is BluetoothDeviceRecord {
  return hasOnlyKeys(value, ['id', 'label', 'surface', 'source', 'identifier', 'name', 'addedAt']) && typeof value.id === 'string' && BT_ID.test(value.id) &&
    isLabel(value.label) && isSurface(value.surface) && (value.source === 'windows-classic' || value.source === 'web-bluetooth') &&
    (value.source === 'windows-classic') === (value.surface === 'desktop') && typeof value.identifier === 'string' &&
    (value.source === 'windows-classic' ? CLASSIC_IDENTIFIER : WEB_BLUETOOTH_IDENTIFIER).test(value.identifier) &&
    typeof value.name === 'string' && value.name.length <= 64 && isIsoTime(value.addedAt);
}
/** The vault authenticator: a sealed secret only, never the secret itself. */
export function validAuthenticator(value: unknown): value is TotpAuthenticatorRecord {
  return hasOnlyKeys(value, ['id', 'label', 'secret', 'lastStep', 'addedAt'], ['addedVia']) && typeof value.id === 'string' && TOTP_ID.test(value.id) &&
    isLabel(value.label) && validSealedSecret(value.secret) && typeof value.lastStep === 'number' && Number.isSafeInteger(value.lastStep) && value.lastStep >= 0 &&
    isIsoTime(value.addedAt) && validAddedVia(value.addedVia);
}
/** A cap is a positive raw amount or null (no cap). */
const validCap = (value: unknown) => value === null || (typeof value === 'string' && RAW.test(value));
const validAssetCaps = (value: unknown) => hasOnlyKeys(value, ['SOL', 'USDC']) && validCap(value.SOL) && validCap(value.USDC);
/** A limits.set request: any mix of caps and nulls (all null turns Limits off); a per-release cap never above that asset's daily cap. */
export const validLimitsChange = (value: unknown) => hasOnlyKeys(value, ['perReleaseRaw', 'perDayRaw']) && validAssetCaps(value.perReleaseRaw) && validAssetCaps(value.perDayRaw) &&
  ['SOL', 'USDC'].every(asset => {
    const once = (value.perReleaseRaw as Record<string, string | null>)[asset], day = (value.perDayRaw as Record<string, string | null>)[asset];
    return once === null || day === null || BigInt(once) <= BigInt(day);
  });
/** Stored Limits (the layer is on): at least one cap is set. */
export const validLimits = (value: unknown) => validLimitsChange(value) &&
  [(value as { perReleaseRaw: Record<string, unknown> }).perReleaseRaw, (value as { perDayRaw: Record<string, unknown> }).perDayRaw].some(caps => caps.SOL !== null || caps.USDC !== null);

export function validAppliedOp(value: unknown): value is AppliedChangeOp {
  const type = (value as { type?: unknown } | null)?.type;
  const shape = (keys: string[]) => hasOnlyKeys(value, ['type', ...keys]);
  const v = value as Record<string, unknown>;
  switch (type) {
    case 'passkey.add': return shape(['credential']) && validPasskey(v.credential);
    case 'passkey.remove': return shape(['credentialId']) && fromBase64Url(v.credentialId, { min: 1, max: 1024 }) !== null;
    case 'device.add': return shape(['device']) && validDevice(v.device);
    case 'device.remove': return shape(['keyId']) && typeof v.keyId === 'string' && KEY_ID.test(v.keyId);
    case 'geolocation.add-zone': return shape(['zone']) && validZone(v.zone);
    case 'geolocation.remove-zone': return shape(['zoneId']) && typeof v.zoneId === 'string' && ZONE_ID.test(v.zoneId);
    case 'wifi.add-network': return shape(['network']) && validNetwork(v.network);
    case 'wifi.remove-network': return shape(['networkId']) && typeof v.networkId === 'string' && NET_ID.test(v.networkId);
    case 'wifi.add-radio': return shape(['radio']) && validRadio(v.radio);
    case 'wifi.add-bssid': return shape(['radioId', 'bssid']) && typeof v.radioId === 'string' && RADIO_ID.test(v.radioId) && typeof v.bssid === 'string' && BSSID.test(v.bssid);
    case 'wifi.remove-radio': return shape(['radioId']) && typeof v.radioId === 'string' && RADIO_ID.test(v.radioId);
    case 'wifi.set-mode': return shape(['mode']) && (v.mode === 'network' || v.mode === 'network+radio');
    case 'bluetooth.add-device': return shape(['device']) && validBluetooth(v.device);
    case 'bluetooth.remove-device': return shape(['deviceId']) && typeof v.deviceId === 'string' && BT_ID.test(v.deviceId);
    case 'mfa.add': return shape(['authenticator']) && validAuthenticator(v.authenticator);
    case 'limits.set': return shape(['perReleaseRaw', 'perDayRaw']) && validLimitsChange({ perReleaseRaw: v.perReleaseRaw, perDayRaw: v.perDayRaw });
    case 'layer.disable': return shape(['layer']) && (isOptional(v.layer) || v.layer === 'limits');
    default: return false;
  }
}
function validPending(value: unknown): value is PendingChange {
  if (!hasOnlyKeys(value, ['id', 'op', 'class', 'waived', 'requestedAt', 'effectiveAt', 'requestedFrom'])) return false;
  const waived = value.waived;
  return typeof value.id === 'string' && CHANGE_ID.test(value.id) && validAppliedOp(value.op) && (value.class === 'loosen' || value.class === 'recovery') &&
    Array.isArray(waived) && waived.every(isOptional) && new Set(waived).size === waived.length && (value.class === 'recovery') === (waived.length > 0) &&
    isIsoTime(value.requestedAt) && isIsoTime(value.effectiveAt) && Date.parse(value.effectiveAt) > Date.parse(value.requestedAt) && (value.requestedFrom === null || isSurface(value.requestedFrom));
}
function validHistory(value: unknown): value is ChangeHistoryEntry {
  return hasOnlyKeys(value, ['id', 'summary', 'class', 'outcome', 'at']) && typeof value.id === 'string' && CHANGE_ID.test(value.id) &&
    typeof value.summary === 'string' && value.summary.length >= 1 && value.summary.length <= 160 &&
    (value.class === 'tighten' || value.class === 'loosen' || value.class === 'recovery') && (value.outcome === 'applied' || value.outcome === 'cancelled') && isIsoTime(value.at);
}

/**
 * True only for a structurally exact VaultLayerConfig (docs/VAULT_LAYERS.md §5.1). `mfa` may be absent in documents
 * written before the vault authenticator existed; vaultStore.ts reads that as null (MFA off).
 */
export function validLayerConfig(value: unknown): value is VaultLayerConfig {
  if (!hasOnlyKeys(value, ['version', 'webauthnUserId', 'biometrics', 'geolocation', 'wifi', 'bluetooth', 'limits', 'devices', 'pending', 'history', 'updatedAt'], ['mfa'])) return false;
  const v = value;
  if (typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1 || v.version > 1e9) return false;
  if (!fromBase64Url(v.webauthnUserId, { exact: 32 }) || !isIsoTime(v.updatedAt)) return false;
  if (v.biometrics !== null && !(hasOnlyKeys(v.biometrics, ['credentials']) && listOf(v.biometrics.credentials, 1, ITEM_LIMITS.passkeys, validPasskey) &&
    uniqueBy(v.biometrics.credentials, item => item.id))) return false;
  if (v.geolocation !== null && !(hasOnlyKeys(v.geolocation, ['zones']) && listOf(v.geolocation.zones, 1, ITEM_LIMITS.zones, validZone) &&
    uniqueBy(v.geolocation.zones, item => item.id))) return false;
  if (v.wifi !== null) {
    if (!hasOnlyKeys(v.wifi, ['mode', 'networks', 'radios']) || (v.wifi.mode !== 'network' && v.wifi.mode !== 'network+radio')) return false;
    if (!listOf(v.wifi.networks, 1, ITEM_LIMITS.networks, validNetwork) || !uniqueBy(v.wifi.networks, item => item.id) || !uniqueBy(v.wifi.networks, item => item.cidr)) return false;
    if (!listOf(v.wifi.radios, v.wifi.mode === 'network+radio' ? 1 : 0, ITEM_LIMITS.radios, validRadio) || !uniqueBy(v.wifi.radios, item => item.id) ||
      !uniqueBy(v.wifi.radios, item => item.ssidHex)) return false;
  }
  if (v.bluetooth !== null && !(hasOnlyKeys(v.bluetooth, ['devices']) && listOf(v.bluetooth.devices, 1, ITEM_LIMITS.bluetooth, validBluetooth) &&
    uniqueBy(v.bluetooth.devices, item => item.id) && uniqueBy(v.bluetooth.devices, item => `${item.surface}:${item.source}:${item.identifier}`))) return false;
  if (v.mfa !== undefined && v.mfa !== null && !validAuthenticator(v.mfa)) return false;
  if (v.limits !== null && !validLimits(v.limits)) return false;
  if (!listOf(v.devices, 0, ITEM_LIMITS.devices, validDevice) || !uniqueBy(v.devices, item => item.keyId)) return false;
  if (!listOf(v.pending, 0, MAX_PENDING_CHANGES, validPending) || !uniqueBy(v.pending, item => item.id)) return false;
  for (let index = 1; index < v.pending.length; index++) if (Date.parse(v.pending[index - 1].effectiveAt) > Date.parse(v.pending[index].effectiveAt)) return false;
  if (!listOf(v.history, 0, HISTORY_LIMIT, validHistory)) return false;
  return true;
}

export function validLayerPass(value: unknown): value is LedgerLayerPass {
  return hasOnlyKeys(value, ['challengeId', 'configVersion', 'passedAt', 'enforced']) && typeof value.challengeId === 'string' && KEY_ID.test(value.challengeId) &&
    typeof value.configVersion === 'number' && Number.isInteger(value.configVersion) && value.configVersion >= 1 && isIsoTime(value.passedAt) &&
    Array.isArray(value.enforced) && value.enforced.length <= LAYER_IDS.length && value.enforced.every(item => (LAYER_IDS as readonly unknown[]).includes(item)) &&
    new Set(value.enforced).size === value.enforced.length;
}
