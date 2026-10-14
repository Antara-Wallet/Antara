/**
 * Change operations (docs/VAULT_LAYERS.md §8.1): strict parsing of the
 * client's request and the normalised form that the change digest binds.
 */
import { GuardianError } from '../guardian.js';
import { cleanLabel, fromBase64Url, hasOnlyKeys, looksIdentifying } from './codec.js';
import { validLatLng, validRadius } from './geo.js';
import { normaliseCidr } from './network.js';
import {
  ENROLL_OP_TYPES, LABEL_MAX, OPTIONAL_LAYER_IDS, PREFIX_BOUNDS, SURFACES, type AssetCapRaw, type ChangeOp, type ChangeOpType, type DisableableLayerId, type OptionalLayerId, type Surface,
} from './types.js';

const invalid = (message: string) => new GuardianError(message, 400, 'invalid');
const ITEM_ID: Record<'zone' | 'net' | 'radio' | 'bt', RegExp> = {
  zone: /^zone_[A-Za-z0-9_-]{16}$/, net: /^net_[A-Za-z0-9_-]{16}$/, radio: /^radio_[A-Za-z0-9_-]{16}$/, bt: /^bt_[A-Za-z0-9_-]{16}$/,
};
export const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const RAW = /^[1-9]\d{0,30}$/;
const OP_TYPES: ReadonlySet<string> = new Set<ChangeOpType>([
  'passkey.add', 'passkey.remove', 'device.add', 'device.remove', 'geolocation.add-zone', 'geolocation.remove-zone', 'wifi.add-network', 'wifi.remove-network',
  'wifi.add-radio', 'wifi.add-bssid', 'wifi.remove-radio', 'wifi.set-mode', 'bluetooth.add-device', 'bluetooth.remove-device', 'limits.set', 'mfa.add', 'layer.disable',
]);

function label(value: unknown): string {
  const text = cleanLabel(value, LABEL_MAX);
  if (!text) throw invalid(`Give it a name of 1 to ${LABEL_MAX} characters.`);
  if (looksIdentifying(text)) throw invalid('Use a name without an IP address, device ID or coordinates.');
  return text;
}
function itemId(value: unknown, kind: keyof typeof ITEM_ID): string {
  if (typeof value !== 'string' || !ITEM_ID[kind].test(value)) throw invalid('Unknown item.');
  return value;
}
/** One optional cap per asset: a positive whole raw amount, or null for no cap (any size; there is no server ceiling). */
function assetCap(value: unknown): AssetCapRaw {
  const cap = (item: unknown) => item === null || (typeof item === 'string' && RAW.test(item));
  if (!hasOnlyKeys(value, ['SOL', 'USDC']) || !cap(value.SOL) || !cap(value.USDC)) {
    throw invalid('Each limit must be a positive whole raw amount, or null for no limit.');
  }
  return { SOL: value.SOL as string | null, USDC: value.USDC as string | null };
}
const isSurface = (value: unknown): value is Surface => typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
export const isOptionalLayer = (value: unknown): value is OptionalLayerId => typeof value === 'string' && (OPTIONAL_LAYER_IDS as readonly string[]).includes(value);

/**
 * Parses a change request strictly: unknown keys, wrong types and out-of-range
 * values are refused (400). `route` limits which ops each route accepts.
 */
export function parseChangeOp(value: unknown, route: 'enroll' | 'change'): ChangeOp {
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !OP_TYPES.has(type)) throw invalid('Unknown protection change.');
  if (ENROLL_OP_TYPES.has(type as ChangeOpType) !== (route === 'enroll')) {
    throw invalid(route === 'enroll' ? 'Use the change routes to remove or change a protection layer.' : 'Use the enroll routes to add to a protection layer.');
  }
  const shape = (required: string[], optional: string[] = []) => {
    if (!hasOnlyKeys(value, ['type', ...required], optional)) throw invalid('The protection change has unexpected or missing fields.');
    return value;
  };
  switch (type as ChangeOpType) {
    case 'passkey.add': { const v = shape(['label']); return { type: 'passkey.add', label: label(v.label) }; }
    case 'passkey.remove': {
      const v = shape(['credentialId']);
      if (!fromBase64Url(v.credentialId, { min: 1, max: 1024 })) throw invalid('Unknown passkey.');
      return { type: 'passkey.remove', credentialId: v.credentialId as string };
    }
    case 'device.add': {
      const v = shape(['label', 'surface', 'publicKeySpki']);
      if (!isSurface(v.surface)) throw invalid('Unknown app surface.');
      if (!fromBase64Url(v.publicKeySpki, { min: 32, max: 200 })) throw invalid('The device key is not a P-256 public key.');
      return { type: 'device.add', label: label(v.label), surface: v.surface, publicKeySpki: v.publicKeySpki as string };
    }
    case 'device.remove': {
      const v = shape(['keyId']);
      if (typeof v.keyId !== 'string' || !KEY_ID.test(v.keyId)) throw invalid('Unknown device.');
      return { type: 'device.remove', keyId: v.keyId };
    }
    case 'geolocation.add-zone': {
      const v = shape(['label', 'radiusM', 'center']);
      if (!validRadius(v.radiusM)) throw invalid('A safe zone needs a radius from 100 m to 50 km, in whole metres.');
      let center: 'current' | { lat: number; lng: number };
      if (v.center === 'current') center = 'current';
      else if (hasOnlyKeys(v.center, ['lat', 'lng']) && validLatLng(v.center.lat, v.center.lng)) center = { lat: v.center.lat as number, lng: v.center.lng as number };
      else throw invalid('The place center must be "current" or a valid latitude and longitude.');
      return { type: 'geolocation.add-zone', label: label(v.label), radiusM: v.radiusM, center };
    }
    case 'geolocation.remove-zone': { const v = shape(['zoneId']); return { type: 'geolocation.remove-zone', zoneId: itemId(v.zoneId, 'zone') }; }
    case 'wifi.add-network': {
      const v = shape(['label'], ['prefixLength', 'cidr']);
      const op: Extract<ChangeOp, { type: 'wifi.add-network' }> = { type: 'wifi.add-network', label: label(v.label) };
      if (v.prefixLength !== undefined && v.cidr !== undefined) throw invalid('Give either a prefix length or a network, not both.');
      if (v.prefixLength !== undefined) {
        if (typeof v.prefixLength !== 'number' || !Number.isInteger(v.prefixLength) || v.prefixLength < PREFIX_BOUNDS.ipv4.min || v.prefixLength > PREFIX_BOUNDS.ipv6.max) {
          throw invalid('The prefix length is out of range (IPv4 /24 to /32, IPv6 /48 to /128).');
        }
        op.prefixLength = v.prefixLength;
      }
      if (v.cidr !== undefined) {
        const cidr = normaliseCidr(v.cidr);
        if (!cidr) throw invalid('The network must be a public IPv4 /24 to /32 or IPv6 /48 to /128 range.');
        op.cidr = cidr;
      }
      return op;
    }
    case 'wifi.remove-network': { const v = shape(['networkId']); return { type: 'wifi.remove-network', networkId: itemId(v.networkId, 'net') }; }
    case 'wifi.add-radio': { const v = shape(['label']); return { type: 'wifi.add-radio', label: label(v.label) }; }
    case 'wifi.add-bssid': { const v = shape(['radioId']); return { type: 'wifi.add-bssid', radioId: itemId(v.radioId, 'radio') }; }
    case 'wifi.remove-radio': { const v = shape(['radioId']); return { type: 'wifi.remove-radio', radioId: itemId(v.radioId, 'radio') }; }
    case 'wifi.set-mode': {
      const v = shape(['mode']);
      if (v.mode !== 'network' && v.mode !== 'network+radio') throw invalid('Unknown Wi-Fi mode.');
      return { type: 'wifi.set-mode', mode: v.mode };
    }
    case 'bluetooth.add-device': { const v = shape(['label']); return { type: 'bluetooth.add-device', label: label(v.label) }; }
    case 'bluetooth.remove-device': { const v = shape(['deviceId']); return { type: 'bluetooth.remove-device', deviceId: itemId(v.deviceId, 'bt') }; }
    case 'limits.set': { const v = shape(['perReleaseRaw', 'perDayRaw']); return { type: 'limits.set', perReleaseRaw: assetCap(v.perReleaseRaw), perDayRaw: assetCap(v.perDayRaw) }; }
    case 'mfa.add': { const v = shape(['label']); return { type: 'mfa.add', label: label(v.label) }; }
    case 'layer.disable': {
      const v = shape(['layer']);
      if (!isOptionalLayer(v.layer) && v.layer !== 'limits') throw invalid('Unknown protection layer.');
      return { type: 'layer.disable', layer: v.layer as DisableableLayerId };
    }
  }
  throw invalid('Unknown protection change.');
}

/**
 * The optional `waive` list of a change request: optional layers the user can
 * no longer satisfy (owner decision O1: a 7-day recovery), including the vault
 * authenticator (MFA). Limits needs no evidence, so there is nothing to waive: it
 * is changed or turned off directly. Returned sorted, as the change digest binds it.
 */
export function parseWaive(value: unknown): OptionalLayerId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OPTIONAL_LAYER_IDS.length) throw invalid('The layers to waive are malformed.');
  if (value.some(item => item === 'limits')) throw invalid('Limits needs no recovery. Change your limits or turn them off instead.');
  if (!value.every(isOptionalLayer) || new Set(value).size !== value.length) throw invalid('The layers to waive are malformed.');
  return [...value].sort();
}

/** Rebuilds `op` with keys in the §8.1 order, so JSON.stringify is deterministic for the change digest. */
export function normaliseOp(op: ChangeOp): ChangeOp {
  switch (op.type) {
    case 'passkey.add': return { type: op.type, label: op.label };
    case 'passkey.remove': return { type: op.type, credentialId: op.credentialId };
    case 'device.add': return { type: op.type, label: op.label, surface: op.surface, publicKeySpki: op.publicKeySpki };
    case 'device.remove': return { type: op.type, keyId: op.keyId };
    case 'geolocation.add-zone': return { type: op.type, label: op.label, radiusM: op.radiusM, center: op.center === 'current' ? 'current' : { lat: op.center.lat, lng: op.center.lng } };
    case 'geolocation.remove-zone': return { type: op.type, zoneId: op.zoneId };
    case 'wifi.add-network': {
      const out: Extract<ChangeOp, { type: 'wifi.add-network' }> = { type: op.type, label: op.label };
      if (op.prefixLength !== undefined) out.prefixLength = op.prefixLength;
      if (op.cidr !== undefined) out.cidr = op.cidr;
      return out;
    }
    case 'wifi.remove-network': return { type: op.type, networkId: op.networkId };
    case 'wifi.add-radio': return { type: op.type, label: op.label };
    case 'wifi.add-bssid': return { type: op.type, radioId: op.radioId };
    case 'wifi.remove-radio': return { type: op.type, radioId: op.radioId };
    case 'wifi.set-mode': return { type: op.type, mode: op.mode };
    case 'bluetooth.add-device': return { type: op.type, label: op.label };
    case 'bluetooth.remove-device': return { type: op.type, deviceId: op.deviceId };
    case 'mfa.add': return { type: op.type, label: op.label };
    case 'limits.set': return { type: op.type, perReleaseRaw: { SOL: op.perReleaseRaw.SOL, USDC: op.perReleaseRaw.USDC }, perDayRaw: { SOL: op.perDayRaw.SOL, USDC: op.perDayRaw.USDC } };
    case 'layer.disable': return { type: op.type, layer: op.layer };
  }
}
