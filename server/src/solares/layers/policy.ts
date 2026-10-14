/**
 * Layer policy (docs/VAULT_LAYERS.md §7, §8): pure and synchronous.
 *
 * - planChange: validates a requested change against the effective
 *   configuration and classifies it (tighten, loosen, recovery). Owner decision
 *   2026-10-13: tightening and loosening both apply at once (loosening still
 *   needs every layer that is on); only a recovery change, which waives a layer
 *   the user can no longer satisfy, waits (7 days, cancelable).
 * - applyChange / effectiveConfig: apply a captured change; due pending changes
 *   apply in effectiveAt order. A pending recovery addition is never usable early.
 * - evaluateLayers: decides whether verified evidence satisfies every
 *   required layer. Any exception, missing reading or mismatch denies.
 * - describeLayers: the GET /solana/layers view, which never returns zone
 *   centers, full IPs, full BSSIDs, Bluetooth identifiers or public keys.
 *
 * Owner decision: a Biometrics passkey is required for every release. A vault
 * without one cannot release, Biometrics can never be turned off, and the last
 * passkey can never be removed (it can be replaced, or waived in a 7-day
 * recovery change, but the vault always keeps at least one).
 *
 * Activation: until a vault has its first passkey, adding one is the only
 * change allowed, so nothing can be pre-positioned for it. The first passkey
 * applies at once only from the Privy session that registered the vault,
 * within ACTIVATION_WINDOW_MS; any other first passkey is a 7-day recovery
 * change that waives Biometrics (visible and cancelable until then).
 *
 * Provenance: passkeys and trusted devices that a recovery change added are
 * marked. Removing the last passkey or device that was not added through
 * recovery, so that only recovery-added ones remain, is a loosening: it needs
 * every layer that is on, so a stolen session whose recovery passkey took
 * effect cannot evict the owner's passkey or devices with that passkey alone.
 *
 * Limits (owner decision 2026-10-13) is optional and off by default: no cap
 * applies until the user sets one, any positive amount is accepted, and there
 * is no server default or ceiling.
 */
import { GuardianError } from '../guardian.js';
import { effectiveReleaseLimits, rawCaps } from '../vaultPolicy.js';
import { toBase64Url, toHex } from './codec.js';
import { BLUETOOTH_SOURCE, GEO_SOURCE, importDeviceKey, keyIdOf, type DeviceKeyRecord } from './device.js';
import { bluetoothMatchId } from './digest.js';
import type { LayerResult } from './errors.js';
import { zoneCheck } from './geo.js';
import { cidrContains, maskCidr, type NetworkObservation } from './network.js';
import type { PasskeyAssertionFacts } from './passkey.js';
import {
  CLOCK_SKEW_MS, HISTORY_LIMIT, ITEM_LIMITS, LAYER_IDS, MAX_PENDING_CHANGES, OPTIONAL_LAYER_IDS, RECOVERY_DELAY_MS,
  type ActivationState, type AppliedChangeOp, type AssetCapRaw, type BluetoothMatch, type DisableableLayerId, type ChangeClass, type ChangeOp, type DevicePayloadV1, type LayerId, type LayerKind, type LayerRequirement,
  type OptionalLayerId, type PendingChange, type Surface, type VaultLayerConfig,
} from './types.js';

export { effectiveReleaseLimits } from '../vaultPolicy.js';

export const LAYER_NAMES: Readonly<Record<LayerId, string>> = {
  bluetooth: 'Bluetooth', wifi: 'Wi-Fi', biometrics: 'Biometrics', geolocation: 'Safe Zones', mfa: 'MFA', limits: 'Limits',
};
export const SURFACE_NAMES: Readonly<Record<Surface, string>> = { desktop: 'Desktop', extension: 'Extension', web: 'Web' };
export const PASSKEY_REQUIRED_MESSAGE = 'Add a passkey (Biometrics) to this vault before releasing. Releases are paused until then.';
const PASSKEY_MANDATORY = 'A passkey is required for every vault release, so Biometrics cannot be turned off. Add another passkey before removing this one.';
export const PASSKEY_FIRST_MESSAGE = 'Add a passkey to this vault first. Other protection changes are possible once it has one.';
export const FIRST_PASSKEY_OTHER_SESSION = 'This vault was just activated from another sign-in. Add its first passkey from the app that activated it. A first passkey added from anywhere else takes effect after 7 days.';
const bluetoothOtherSurface = (surface: Surface) =>
  `Bluetooth is on, and no trusted Bluetooth device is set up for ${SURFACE_NAMES[surface]}, so this app cannot pass it. Bluetooth devices are trusted per app: add this app as a recovery change that waives Bluetooth (7 days).`;
const conflict = (message: string) => new GuardianError(message, 409, 'conflict');
const invalid = (message: string) => new GuardianError(message, 400, 'invalid');
const denied = (message: string) => new GuardianError(message, 403, 'denied');

/** Thrown by applyChange when a change's target no longer exists or it would break an invariant (it is then recorded as cancelled). */
export class ChangeNotApplicableError extends Error {
  constructor(message = 'The change no longer applies.') { super(message); this.name = 'ChangeNotApplicableError'; }
}

export function emptyLayerConfig(webauthnUserId: string, at: string): VaultLayerConfig {
  return { version: 0, webauthnUserId, biometrics: null, geolocation: null, wifi: null, bluetooth: null, mfa: null, limits: null, devices: [], pending: [], history: [], updatedAt: at };
}
const clone = <T>(value: T): T => structuredClone(value);

/** Optional layers that are on (each has at least one active item), in landing order. */
export function enabledLayers(config: VaultLayerConfig | null): OptionalLayerId[] {
  if (!config) return [];
  return OPTIONAL_LAYER_IDS.filter(id => config[id] !== null);
}
/** A layer whose evidence is a device reading signed by a trusted device key. */
export function deviceLayersEnabled(config: VaultLayerConfig | null): boolean {
  return !!config && (config.geolocation !== null || config.bluetooth !== null || config.wifi?.mode === 'network+radio');
}
export const needsDeviceReading = (config: VaultLayerConfig | null, required: readonly OptionalLayerId[]): boolean =>
  required.includes('geolocation') || required.includes('bluetooth') || (required.includes('wifi') && config?.wifi?.mode === 'network+radio');

/**
 * Requirement list for a begin answer: optional layers in §9.2 order, then MFA when the vault
 * authenticator is on (a code is part of the evidence), and Limits for a release when the user set caps.
 *
 * Bluetooth `match` never returns a stored hardware address: a Desktop
 * (windows-classic) device is listed by bluetoothMatchId(nonce, address) with
 * no name, bound to this challenge's nonce, and is left out when there is no
 * challenge (the 403 layers-required answer; the client takes its list from
 * the begin answer). A Web Bluetooth device keeps its name, which is the
 * requestDevice filter, and Chrome's per-origin id, which identifies nothing
 * outside this origin.
 */
export function requirementList(config: VaultLayerConfig | null, required: readonly OptionalLayerId[], release: boolean, nonce: Uint8Array | null): LayerRequirement[] {
  const list: LayerRequirement[] = [];
  if (required.includes('biometrics')) list.push({ id: 'biometrics', evidence: 'passkey' });
  if (required.includes('geolocation')) list.push({ id: 'geolocation', evidence: 'device', reading: 'geo' });
  if (required.includes('wifi')) {
    list.push(config?.wifi?.mode === 'network+radio' ? { id: 'wifi', evidence: 'device', reading: 'wifi', desktopOnly: true } : { id: 'wifi', evidence: 'server' });
  }
  if (required.includes('bluetooth')) {
    list.push({
      id: 'bluetooth', evidence: 'device', reading: 'bluetooth',
      match: (config?.bluetooth?.devices ?? []).flatMap((device): BluetoothMatch[] => device.source === 'web-bluetooth'
        ? [{ surface: device.surface, source: device.source, identifier: device.identifier, name: device.name }]
        : nonce ? [{ surface: device.surface, source: device.source, identifier: bluetoothMatchId(nonce, device.identifier), name: '' }] : []),
    });
  }
  if (required.includes('mfa')) list.push({ id: 'mfa', evidence: 'totp' });
  if (release && config?.limits) list.push({ id: 'limits', evidence: 'server' });
  return list;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export interface ChangeCapture { registration?: true; proof?: true; geo?: true; wifi?: true; bluetooth?: true; network?: true; totp?: true }
export interface ChangePlan {
  class: ChangeClass;
  /** Optional layers whose evidence the finish must carry. */
  required: OptionalLayerId[];
  /**
   * Layers the change is made without (sorted): the request's waivers, plus
   * Biometrics for a first passkey outside the activation window. Non-empty
   * exactly when the class is recovery.
   */
  waived: OptionalLayerId[];
  capture: ChangeCapture;
  /** null when the change applies immediately (tighten and loosen); RECOVERY_DELAY_MS for a recovery change. */
  delayMs: number | null;
  /** device.add: the candidate key's id. */
  candidateKeyId?: string;
}

/** Items that pending additions would add, counted against the caps. */
function pendingAdds(config: VaultLayerConfig, type: AppliedChangeOp['type']): number {
  return config.pending.filter(change => change.op.type === type).length;
}
function targetKey(op: ChangeOp | AppliedChangeOp): string | null {
  switch (op.type) {
    case 'passkey.remove': return `passkey:${op.credentialId}`;
    case 'device.remove': return `device:${op.keyId}`;
    case 'geolocation.remove-zone': return `zone:${op.zoneId}`;
    case 'wifi.remove-network': return `net:${op.networkId}`;
    case 'wifi.remove-radio': return `radio:${op.radioId}`;
    case 'bluetooth.remove-device': return `bt:${op.deviceId}`;
    case 'layer.disable': return `layer:${op.layer}`;
    case 'wifi.set-mode': return 'wifi-mode';
    case 'limits.set': return 'limits';
    default: return null;
  }
}

/**
 * Validates `op` against the effective configuration and classifies it.
 * Throws GuardianError 400 (malformed for this vault), 403 (never allowed) or
 * 409 (conflicts with the current state, item counts or pending changes).
 * `activation` is the vault's first-passkey window for this request; absent
 * means no open window, so a first passkey is a recovery change.
 */
export function planChange(input: {
  config: VaultLayerConfig | null; op: ChangeOp; waived: readonly OptionalLayerId[];
  activation?: ActivationState;
}): ChangePlan {
  const config = input.config ?? emptyLayerConfig('A'.repeat(43), new Date(0).toISOString());
  const op = input.op;
  const capture: ChangeCapture = {};
  let base: 'tighten' | 'loosen';
  let candidateKeyId: string | undefined;
  let firstPasskeyRecovery = false;
  const cap = (count: number, max: number, what: string) => { if (count >= max) throw conflict(`You already have the maximum of ${max} ${what}.`); };
  // Until the vault has a passkey, nothing else can be enrolled, removed or changed: no device, place,
  // network or Bluetooth device can be pre-positioned before the owner's passkey exists.
  if (!config.biometrics && op.type !== 'passkey.add') throw conflict(PASSKEY_FIRST_MESSAGE);
  const target = targetKey(op);
  if (target && config.pending.some(change => targetKey(change.op) === target)) throw conflict('A change for this is already pending. Cancel it first.');
  switch (op.type) {
    case 'passkey.add':
      cap((config.biometrics?.credentials.length ?? 0) + pendingAdds(config, 'passkey.add'), ITEM_LIMITS.passkeys, 'passkeys');
      if (config.biometrics) base = 'loosen';
      // The first passkey applies at once only from the session that registered the vault, within the window.
      else if (input.activation === 'session') base = 'tighten';
      else if (input.activation === 'other-session') throw denied(FIRST_PASSKEY_OTHER_SESSION);
      else { base = 'tighten'; firstPasskeyRecovery = true; }
      capture.registration = true; break;
    case 'passkey.remove': {
      const credentials = config.biometrics?.credentials ?? [];
      const removed = credentials.find(item => item.id === op.credentialId);
      if (!removed) throw conflict('That passkey is not active on this vault.');
      const removing = new Set(config.pending.flatMap(change => change.op.type === 'passkey.remove' ? [change.op.credentialId] : []));
      const remaining = credentials.filter(item => item.id !== op.credentialId && !removing.has(item.id));
      if (!remaining.length) throw denied(PASSKEY_MANDATORY);
      // Removing the last passkey not added through recovery leaves only recovery-added ones: a loosening (every layer that is on).
      base = removed.addedVia !== 'recovery' && remaining.every(item => item.addedVia === 'recovery') ? 'loosen' : 'tighten'; break;
    }
    case 'device.add': {
      let spki: Uint8Array;
      try { ({ spki } = importDeviceKey(op.publicKeySpki)); } catch { throw invalid('The device key is not a P-256 public key.'); }
      candidateKeyId = keyIdOf(spki);
      if (config.devices.some(device => device.keyId === candidateKeyId) ||
        config.pending.some(change => change.op.type === 'device.add' && change.op.device.keyId === candidateKeyId)) throw conflict('This device is already trusted for this vault.');
      cap(config.devices.length + pendingAdds(config, 'device.add'), ITEM_LIMITS.devices, 'trusted devices');
      base = deviceLayersEnabled(config) ? 'loosen' : 'tighten'; capture.proof = true; break;
    }
    case 'device.remove': {
      const removed = config.devices.find(device => device.keyId === op.keyId);
      if (!removed) throw conflict('That device is not trusted for this vault.');
      const removing = new Set(config.pending.flatMap(change => change.op.type === 'device.remove' ? [change.op.keyId] : []));
      const remaining = config.devices.filter(device => device.keyId !== op.keyId && !removing.has(device.keyId));
      // Removing the last trusted device not added through recovery, while recovery-added ones remain, is a loosening.
      base = removed.addedVia !== 'recovery' && remaining.length > 0 && remaining.every(device => device.addedVia === 'recovery') ? 'loosen' : 'tighten'; break;
    }
    case 'geolocation.add-zone':
      cap((config.geolocation?.zones.length ?? 0) + pendingAdds(config, 'geolocation.add-zone'), ITEM_LIMITS.zones, 'safe zones');
      base = config.geolocation ? 'loosen' : 'tighten';
      if (op.center === 'current') capture.geo = true;
      break;
    case 'geolocation.remove-zone': {
      const zones = config.geolocation?.zones ?? [];
      if (!zones.some(zone => zone.id === op.zoneId)) throw conflict('That safe zone is not active on this vault.');
      base = zones.length === 1 ? 'loosen' : 'tighten'; break;
    }
    case 'wifi.add-network':
      cap((config.wifi?.networks.length ?? 0) + pendingAdds(config, 'wifi.add-network'), ITEM_LIMITS.networks, 'trusted networks');
      if (op.cidr && config.wifi?.networks.some(network => network.cidr === op.cidr)) throw conflict('That network is already trusted.');
      base = config.wifi ? 'loosen' : 'tighten';
      if (!op.cidr) capture.network = true;
      break;
    case 'wifi.remove-network': {
      const networks = config.wifi?.networks ?? [];
      if (!networks.some(network => network.id === op.networkId)) throw conflict('That network is not active on this vault.');
      base = networks.length === 1 ? 'loosen' : 'tighten'; break;
    }
    case 'wifi.add-radio':
      if (!config.wifi) throw conflict('Add a trusted network before adding a Wi-Fi name.');
      cap(config.wifi.radios.length + pendingAdds(config, 'wifi.add-radio'), ITEM_LIMITS.radios, 'Wi-Fi names');
      base = config.wifi.mode === 'network' && config.wifi.radios.length === 0 ? 'tighten' : 'loosen'; capture.wifi = true; break;
    case 'wifi.add-bssid': {
      const radio = config.wifi?.radios.find(item => item.id === op.radioId);
      if (!radio) throw conflict('That Wi-Fi name is not active on this vault.');
      cap(radio.bssids.length + config.pending.filter(change => change.op.type === 'wifi.add-bssid' && change.op.radioId === op.radioId).length, ITEM_LIMITS.bssids, 'access points for this Wi-Fi name');
      base = 'loosen'; capture.wifi = true; break;
    }
    case 'wifi.remove-radio': {
      const radios = config.wifi?.radios ?? [];
      if (!radios.some(radio => radio.id === op.radioId)) throw conflict('That Wi-Fi name is not active on this vault.');
      base = config.wifi?.mode === 'network+radio' && radios.length === 1 ? 'loosen' : 'tighten'; break;
    }
    case 'wifi.set-mode':
      if (!config.wifi) throw conflict('The Wi-Fi layer is off.');
      if (config.wifi.mode === op.mode) throw conflict('The Wi-Fi layer already uses this mode.');
      if (op.mode === 'network+radio' && config.wifi.radios.length === 0) throw conflict('Add a Wi-Fi name from ANTARA Desktop first.');
      base = op.mode === 'network+radio' ? 'tighten' : 'loosen'; break;
    case 'bluetooth.add-device':
      cap((config.bluetooth?.devices.length ?? 0) + pendingAdds(config, 'bluetooth.add-device'), ITEM_LIMITS.bluetooth, 'Bluetooth devices');
      base = config.bluetooth ? 'loosen' : 'tighten'; capture.bluetooth = true; break;
    case 'bluetooth.remove-device': {
      const devices = config.bluetooth?.devices ?? [];
      if (!devices.some(device => device.id === op.deviceId)) throw conflict('That Bluetooth device is not active on this vault.');
      base = devices.length === 1 ? 'loosen' : 'tighten'; break;
    }
    case 'mfa.add':
      // One vault authenticator at a time. Replacing it means turning MFA off first, or a 7-day recovery that waives it.
      if (config.mfa) throw conflict('MFA is already on for this vault. Turn it off first to use a different authenticator app.');
      if (pendingAdds(config, 'mfa.add')) throw conflict('An authenticator app is already being added to this vault. Cancel that change first.');
      base = 'tighten'; capture.totp = true; break;
    case 'limits.set': {
      // Any positive cap, per asset, per release and/or per day; null is "no cap". There is no server ceiling or minimum.
      const proposed = limitsFromChange(op);
      if (!proposed && !config.limits) throw conflict('Limits are already off.');
      const inForce = effectiveReleaseLimits(config.limits);
      const caps = effectiveReleaseLimits(proposed);
      let tighter = true;
      for (const asset of ['SOL', 'USDC'] as const) {
        const once = caps.perRelease[asset], day = caps.perDay[asset];
        if (once !== null && day !== null && once > day) throw invalid(`The ${asset} per-release limit cannot be above its daily limit.`);
        // No cap counts as unlimited: removing or raising any cap loosens.
        for (const kind of ['perRelease', 'perDay'] as const) {
          const before = inForce[kind][asset], after = caps[kind][asset];
          if (before !== null && (after === null || after > before)) tighter = false;
        }
      }
      base = tighter ? 'tighten' : 'loosen'; break;
    }
    case 'layer.disable':
      if (op.layer === 'biometrics') throw denied(PASSKEY_MANDATORY);
      if (config[op.layer] === null) throw conflict(`${LAYER_NAMES[op.layer]} is already off.`);
      base = 'loosen'; break;
  }
  const enabled = enabledLayers(input.config);
  const waived = [...input.waived];
  for (const layer of waived) if (!enabled.includes(layer)) throw invalid(`${LAYER_NAMES[layer]} is not on, so it cannot be waived.`);
  // A first passkey outside the activation window cannot carry the Biometrics evidence (no passkey exists yet), so it is a recovery change that waives it.
  if (firstPasskeyRecovery) waived.push('biometrics');
  waived.sort();
  const changeClass: ChangeClass = waived.length ? 'recovery' : base;
  if (changeClass === 'recovery' && config.pending.length >= MAX_PENDING_CHANGES) throw conflict(`At most ${MAX_PENDING_CHANGES} changes can be pending. Cancel one or wait.`);
  // Tightening needs only the passkey (limits lock-out pranks with a stolen session); loosening needs every layer that is on.
  const required = changeClass === 'tighten' ? enabled.filter(layer => layer === 'biometrics') : enabled.filter(layer => !waived.includes(layer));
  // Bluetooth devices are trusted per app: a new app's key can never pass a Bluetooth layer enrolled only for another app, so say so before any ceremony.
  if (op.type === 'device.add' && required.includes('bluetooth') && !config.bluetooth?.devices.some(device => device.surface === op.surface)) throw conflict(bluetoothOtherSurface(op.surface));
  // Owner decision 2026-10-13: no waiting to add to a layer, loosen it or turn it off; only lost-device recovery waits.
  const delayMs = changeClass === 'recovery' ? RECOVERY_DELAY_MS : null;
  return { class: changeClass, required, waived, capture, delayMs, ...(candidateKeyId ? { candidateKeyId } : {}) };
}

/** The Limits record a limits.set change would store; null when every value is null (Limits off). */
export function limitsFromChange(op: { perReleaseRaw: AssetCapRaw; perDayRaw: AssetCapRaw }): VaultLayerConfig['limits'] {
  const values = [op.perReleaseRaw.SOL, op.perReleaseRaw.USDC, op.perDayRaw.SOL, op.perDayRaw.USDC];
  return values.every(value => value === null) ? null : { perReleaseRaw: { ...op.perReleaseRaw }, perDayRaw: { ...op.perDayRaw } };
}

function withItem<T>(list: readonly T[], item: T, max: number, same: (a: T) => boolean): T[] {
  if (list.some(same)) throw new ChangeNotApplicableError('It already exists.');
  if (list.length >= max) throw new ChangeNotApplicableError('The limit is reached.');
  return [...list, item];
}
function without<T>(list: readonly T[], match: (item: T) => boolean): T[] {
  if (!list.some(match)) throw new ChangeNotApplicableError('Its target no longer exists.');
  return list.filter(item => !match(item));
}
/** Applies one captured change to a copy of `config` (version unchanged). Throws ChangeNotApplicableError when its target is gone. */
export function applyChange(config: VaultLayerConfig, op: AppliedChangeOp): VaultLayerConfig {
  const next = clone(config);
  switch (op.type) {
    case 'passkey.add': next.biometrics = { credentials: withItem(next.biometrics?.credentials ?? [], op.credential, ITEM_LIMITS.passkeys, item => item.id === op.credential.id) }; break;
    case 'passkey.remove': {
      const credentials = without(next.biometrics?.credentials ?? [], item => item.id === op.credentialId);
      // The passkey is mandatory: the last one is never removed.
      if (!credentials.length) throw new ChangeNotApplicableError(PASSKEY_MANDATORY);
      next.biometrics = { credentials }; break;
    }
    case 'device.add': next.devices = withItem(next.devices, op.device, ITEM_LIMITS.devices, item => item.keyId === op.device.keyId); break;
    case 'device.remove': next.devices = without(next.devices, item => item.keyId === op.keyId); break;
    case 'geolocation.add-zone': next.geolocation = { zones: withItem(next.geolocation?.zones ?? [], op.zone, ITEM_LIMITS.zones, item => item.id === op.zone.id) }; break;
    case 'geolocation.remove-zone': {
      const zones = without(next.geolocation?.zones ?? [], item => item.id === op.zoneId);
      next.geolocation = zones.length ? { zones } : null; break;
    }
    case 'wifi.add-network': {
      const networks = withItem(next.wifi?.networks ?? [], op.network, ITEM_LIMITS.networks, item => item.id === op.network.id || item.cidr === op.network.cidr);
      next.wifi = next.wifi ? { ...next.wifi, networks } : { mode: 'network', networks, radios: [] }; break;
    }
    case 'wifi.remove-network': {
      if (!next.wifi) throw new ChangeNotApplicableError();
      const networks = without(next.wifi.networks, item => item.id === op.networkId);
      next.wifi = networks.length ? { ...next.wifi, networks } : null; break;
    }
    case 'wifi.add-radio': {
      if (!next.wifi) throw new ChangeNotApplicableError();
      next.wifi.radios = withItem(next.wifi.radios, op.radio, ITEM_LIMITS.radios, item => item.id === op.radio.id || item.ssidHex === op.radio.ssidHex); break;
    }
    case 'wifi.add-bssid': {
      const radio = next.wifi?.radios.find(item => item.id === op.radioId);
      if (!radio) throw new ChangeNotApplicableError();
      radio.bssids = withItem(radio.bssids, op.bssid, ITEM_LIMITS.bssids, item => item === op.bssid); break;
    }
    case 'wifi.remove-radio': {
      if (!next.wifi) throw new ChangeNotApplicableError();
      next.wifi.radios = without(next.wifi.radios, item => item.id === op.radioId);
      if (!next.wifi.radios.length) next.wifi.mode = 'network';
      break;
    }
    case 'wifi.set-mode':
      if (!next.wifi || next.wifi.mode === op.mode || (op.mode === 'network+radio' && !next.wifi.radios.length)) throw new ChangeNotApplicableError();
      next.wifi.mode = op.mode; break;
    case 'bluetooth.add-device': {
      const same = (item: { id: string; surface: Surface; source: string; identifier: string }) =>
        item.id === op.device.id || (item.surface === op.device.surface && item.source === op.device.source && item.identifier === op.device.identifier);
      next.bluetooth = { devices: withItem(next.bluetooth?.devices ?? [], op.device, ITEM_LIMITS.bluetooth, same) }; break;
    }
    case 'bluetooth.remove-device': {
      const devices = without(next.bluetooth?.devices ?? [], item => item.id === op.deviceId);
      next.bluetooth = devices.length ? { devices } : null; break;
    }
    case 'limits.set':
      next.limits = limitsFromChange(op);
      if (!next.limits && !config.limits) throw new ChangeNotApplicableError();
      break;
    case 'mfa.add':
      if (next.mfa) throw new ChangeNotApplicableError('It already exists.');
      next.mfa = clone(op.authenticator); break;
    case 'layer.disable':
      if (op.layer === 'biometrics') throw new ChangeNotApplicableError(PASSKEY_MANDATORY);
      if (next[op.layer] === null) throw new ChangeNotApplicableError();
      next[op.layer] = null; break;
  }
  return next;
}

/**
 * Short fixed text for pending changes and history: ANTARA's words only, never a user label, reading,
 * address or identifier. The label is returned apart (changeLabel), so a label that looks like an
 * address can never make a client discard the pending list (docs/VAULT_LAYERS.md §9.1).
 */
export function summariseChange(op: AppliedChangeOp): string {
  switch (op.type) {
    case 'passkey.add': return 'Add a passkey';
    case 'passkey.remove': return 'Remove a passkey';
    case 'device.add': return `Trust a device (${SURFACE_NAMES[op.device.surface]})`;
    case 'device.remove': return 'Remove a trusted device';
    case 'geolocation.add-zone': return 'Add a safe zone';
    case 'geolocation.remove-zone': return 'Remove a safe zone';
    case 'wifi.add-network': return 'Add a trusted network';
    case 'wifi.remove-network': return 'Remove a trusted network';
    case 'wifi.add-radio': return 'Add a Wi-Fi name';
    case 'wifi.add-bssid': return 'Add an access point to a Wi-Fi name';
    case 'wifi.remove-radio': return 'Remove a Wi-Fi name';
    case 'wifi.set-mode': return op.mode === 'network+radio' ? 'Also require the Wi-Fi name and access point on Desktop' : 'Stop requiring the Wi-Fi name and access point';
    case 'bluetooth.add-device': return 'Add a Bluetooth device';
    case 'bluetooth.remove-device': return 'Remove a Bluetooth device';
    case 'limits.set': return limitsFromChange(op) ? 'Change this vault\'s release limits' : 'Turn off Limits';
    case 'mfa.add': return 'Add a vault authenticator app';
    case 'layer.disable': return `Turn off ${LAYER_NAMES[op.layer]}`;
  }
}

/** The user's label of the item a change adds or removes, when there is one; returned apart from the summary. */
export function changeLabel(op: AppliedChangeOp, config: VaultLayerConfig | null): string | undefined {
  switch (op.type) {
    case 'passkey.add': return op.credential.label;
    case 'passkey.remove': return config?.biometrics?.credentials.find(item => item.id === op.credentialId)?.label;
    case 'device.add': return op.device.label;
    case 'device.remove': return config?.devices.find(item => item.keyId === op.keyId)?.label;
    case 'geolocation.add-zone': return op.zone.label;
    case 'geolocation.remove-zone': return config?.geolocation?.zones.find(item => item.id === op.zoneId)?.label;
    case 'wifi.add-network': return op.network.label;
    case 'wifi.remove-network': return config?.wifi?.networks.find(item => item.id === op.networkId)?.label;
    case 'wifi.add-radio': return op.radio.label;
    case 'wifi.add-bssid': case 'wifi.remove-radio': return config?.wifi?.radios.find(item => item.id === op.radioId)?.label;
    case 'bluetooth.add-device': return op.device.label;
    case 'bluetooth.remove-device': return config?.bluetooth?.devices.find(item => item.id === op.deviceId)?.label;
    case 'mfa.add': return op.authenticator.label;
    case 'wifi.set-mode': case 'limits.set': case 'layer.disable': return undefined;
  }
}

/** Marks the passkey or trusted device a recovery change adds, so removing the owner's last original one is a loosening (planChange). */
function withRecoveryProvenance(op: AppliedChangeOp): AppliedChangeOp {
  if (op.type === 'passkey.add') return { ...op, credential: { ...op.credential, addedVia: 'recovery' } };
  if (op.type === 'device.add') return { ...op, device: { ...op.device, addedVia: 'recovery' } };
  if (op.type === 'mfa.add') return { ...op, authenticator: { ...op.authenticator, addedVia: 'recovery' } };
  return op;
}

export interface EffectiveConfig {
  config: VaultLayerConfig;
  /** True when due pending changes were applied or dropped; the next write persists it. */
  changed: boolean;
}
/**
 * Applies every pending change whose effectiveAt has passed, in order, at
 * version +1 each. A change whose target no longer exists is dropped and
 * recorded as cancelled. A 'loosen' change stored before 2026-10-13 (when
 * loosening waited 24 hours) is due at once: its requester already passed every
 * layer that was on, and loosening no longer waits. Pure: the caller persists
 * the result on its next write.
 */
export function effectiveConfig(config: VaultLayerConfig, now: number): EffectiveConfig {
  let current = clone(config);
  const isDue = (change: PendingChange) => change.class === 'loosen' || Date.parse(change.effectiveAt) <= now;
  const due = config.pending.filter(isDue);
  if (!due.length) return { config: current, changed: false };
  current.pending = config.pending.filter(change => !isDue(change));
  for (const change of due) {
    const summary = summariseChange(change.op);
    const at = Date.parse(change.effectiveAt) <= now ? change.effectiveAt : new Date(now).toISOString();
    try {
      current = applyChange(current, change.class === 'recovery' ? withRecoveryProvenance(change.op) : change.op);
      current.history.push({ id: change.id, summary, class: change.class, outcome: 'applied', at });
    } catch (error) {
      if (!(error instanceof ChangeNotApplicableError)) throw error;
      current.history.push({ id: change.id, summary, class: change.class, outcome: 'cancelled', at });
    }
    current.version += 1;
    current.updatedAt = at;
  }
  current.history = current.history.slice(-HISTORY_LIMIT);
  return { config: current, changed: true };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type PasskeyOutcome = { ok: true; facts: PasskeyAssertionFacts } | { ok: false; reason: string } | null;
/** A vault authenticator code checked against the stored secret: the 30-second step it matched, or why not. Single use is the service's (lastStep). */
export type TotpOutcome = { ok: true; step: number } | { ok: false; reason: string } | null;
export type DeviceOutcome = { ok: true; payload: DevicePayloadV1; key: DeviceKeyRecord } | { ok: false; reason: string } | null;
export interface EvaluationChallenge { id: string; nonce: Uint8Array; digest: Uint8Array; purpose: 'release' | 'change'; issuedAt: number }
export interface LayerEvaluationInput {
  /** The effective configuration (due pending changes applied). */
  config: VaultLayerConfig | null;
  /** Optional layers to check (the challenge's list). */
  required: readonly OptionalLayerId[];
  challenge: EvaluationChallenge;
  passkey: PasskeyOutcome;
  device: DeviceOutcome;
  /** The MFA layer's code, checked by the service (layers/totp.ts). Absent or null fails MFA when it is required. */
  totp?: TotpOutcome;
  network: NetworkObservation;
  now: number;
  /**
   * Wi-Fi captures only (a documented exception, docs/VAULT_LAYERS.md §8.2).
   * The access point (wifi.add-bssid) or Wi-Fi name (wifi.add-radio) being
   * added is by definition not enrolled yet, and one computer is connected to
   * one network at a time, so in network+radio mode the device-reported radio
   * check cannot prove an enrolled network for these two changes:
   * - wifi.add-radio passes it for exactly one connection, of any name
   * - wifi.add-bssid passes it for a connection whose name is that radio's
   * Everything else still applies: the server-observed trusted-network check,
   * the trusted Desktop key and every other enabled layer.
   */
  radioCapture?: { radioId: string } | { newRadio: true };
}
export interface LayerDecision { ok: boolean; layers: LayerResult[]; enforced: LayerId[] }

export const LAYER_FAILURES = Object.freeze({
  untrustedDevice: "This device isn't trusted for this vault yet.",
  staleReading: 'The device reading is invalid or expired. Try again.',
  mixedApps: 'Evidence came from different apps. Verify everything from the same ANTARA app.',
  passkey: 'Your passkey was not verified for this request.',
  network: 'This request does not come from one of your trusted networks.',
  wifiDesktop: "This vault's Wi-Fi layer requires ANTARA Desktop.",
  wifiRadio: 'This computer is not connected to one of your trusted Wi-Fi networks.',
  bluetooth: 'Your trusted Bluetooth device was not found.',
  bluetoothSurface: (surface: Surface) => `No trusted Bluetooth device is set up for ${SURFACE_NAMES[surface]}. Bluetooth devices are trusted per app.`,
  geoMissing: 'No location reading was sent.',
  totpMissing: 'Enter the 6-digit code from your vault authenticator app.',
  totp: 'That authenticator code is wrong, expired or already used. Wait for the next code and try again.',
  unchecked: 'This layer could not be checked.',
});

/**
 * Checks that a verified device payload belongs to this exact challenge: key,
 * surface, challenge id, nonce, digest, purpose, and every timestamp within
 * [issuedAt - skew, now + skew].
 */
export function checkDeviceBinding(device: DeviceOutcome, challenge: EvaluationChallenge, now: number): { ok: true; payload: DevicePayloadV1; surface: Surface } | { ok: false; reason: string } {
  if (!device) return { ok: false, reason: LAYER_FAILURES.untrustedDevice };
  if (!device.ok) return { ok: false, reason: device.reason };
  const { payload, key } = device;
  const earliest = challenge.issuedAt - CLOCK_SKEW_MS, latest = now + CLOCK_SKEW_MS;
  const inWindow = (at: number) => Number.isFinite(at) && at >= earliest && at <= latest;
  if (payload.keyId !== key.keyId || payload.surface !== key.surface) return { ok: false, reason: LAYER_FAILURES.untrustedDevice };
  if (payload.challengeId !== challenge.id || payload.nonce !== toBase64Url(challenge.nonce) || payload.digest !== toHex(challenge.digest) || payload.purpose !== challenge.purpose) {
    return { ok: false, reason: LAYER_FAILURES.staleReading };
  }
  if (!inWindow(payload.signedAt) || [payload.geo?.at, payload.wifi?.at, payload.bluetooth?.at].some(at => at !== undefined && !inWindow(at))) {
    return { ok: false, reason: LAYER_FAILURES.staleReading };
  }
  return { ok: true, payload, surface: key.surface };
}

/** Decides every required layer. Any exception denies all of them. */
export function evaluateLayers(input: LayerEvaluationInput): LayerDecision {
  const ordered = LAYER_IDS.filter((id): id is OptionalLayerId => (input.required as readonly string[]).includes(id));
  // Limits is enforced (by the release policy and the store) only when the user set caps.
  const enforced: LayerId[] = input.config?.limits ? [...ordered, 'limits'] : [...ordered];
  try {
    if (!ordered.length) return { ok: true, layers: [], enforced };
    const config = input.config;
    if (!config) throw new Error('No layer configuration.');
    const device = needsDeviceReading(config, ordered) ? checkDeviceBinding(input.device, input.challenge, input.now) : null;
    const passkey = input.passkey;
    // One app must produce all of the evidence.
    if (passkey?.ok && input.device?.ok && (passkey.facts.surface !== input.device.payload.surface || passkey.facts.surface !== input.device.key.surface)) {
      return { ok: false, layers: ordered.map(id => ({ id, ok: false, reason: LAYER_FAILURES.mixedApps })), enforced };
    }
    const layers: LayerResult[] = ordered.map((id): LayerResult => {
      switch (id) {
        case 'biometrics':
          if (!config.biometrics) return { id, ok: false, reason: LAYER_FAILURES.passkey };
          return passkey?.ok && config.biometrics.credentials.some(item => item.id === passkey.facts.credentialId)
            ? { id, ok: true } : { id, ok: false, reason: passkey && !passkey.ok ? passkey.reason : LAYER_FAILURES.passkey };
        case 'geolocation': {
          if (!config.geolocation) return { id, ok: false, reason: LAYER_FAILURES.geoMissing };
          if (!device?.ok) return { id, ok: false, reason: device?.reason ?? LAYER_FAILURES.untrustedDevice };
          const geo = device.payload.geo;
          if (!geo) return { id, ok: false, reason: LAYER_FAILURES.geoMissing };
          if (geo.source !== GEO_SOURCE[device.surface]) return { id, ok: false, reason: LAYER_FAILURES.staleReading };
          const check = zoneCheck(geo, config.geolocation.zones);
          return check.ok ? { id, ok: true } : { id, ok: false, reason: check.reason };
        }
        case 'wifi': {
          const wifi = config.wifi;
          if (!wifi) return { id, ok: false, reason: LAYER_FAILURES.network };
          const network = input.network;
          if (network.status !== 'public' || !wifi.networks.some(item => cidrContains(item.cidr, network.ip))) return { id, ok: false, reason: LAYER_FAILURES.network };
          if (wifi.mode === 'network') return { id, ok: true };
          if (!device?.ok) return { id, ok: false, reason: device?.reason ?? LAYER_FAILURES.untrustedDevice };
          if (device.surface !== 'desktop') return { id, ok: false, reason: LAYER_FAILURES.wifiDesktop };
          const reading = device.payload.wifi;
          if (!reading || reading.source !== 'windows-wlan') return { id, ok: false, reason: LAYER_FAILURES.wifiRadio };
          const capture = input.radioCapture;
          if (capture && 'newRadio' in capture) return reading.connections.length === 1 ? { id, ok: true } : { id, ok: false, reason: LAYER_FAILURES.wifiRadio };
          const matched = reading.connections.some(connection => wifi.radios.some(radio => radio.ssidHex === connection.ssidHex &&
            (radio.bssids.includes(connection.bssid) || (capture !== undefined && radio.id === capture.radioId))));
          return matched ? { id, ok: true } : { id, ok: false, reason: LAYER_FAILURES.wifiRadio };
        }
        case 'bluetooth': {
          if (!config.bluetooth) return { id, ok: false, reason: LAYER_FAILURES.bluetooth };
          if (!device?.ok) return { id, ok: false, reason: device?.reason ?? LAYER_FAILURES.untrustedDevice };
          const reading = device.payload.bluetooth;
          const source = BLUETOOTH_SOURCE[device.surface];
          const enrolled = config.bluetooth.devices.filter(item => item.surface === device.surface && item.source === source);
          // Identifiers differ per app, so a device enrolled for another app can never match here.
          if (!enrolled.length) return { id, ok: false, reason: LAYER_FAILURES.bluetoothSurface(device.surface) };
          if (!reading || reading.source !== source) return { id, ok: false, reason: LAYER_FAILURES.bluetooth };
          return reading.devices.some(seen => enrolled.some(item => item.identifier === seen.identifier)) ? { id, ok: true } : { id, ok: false, reason: LAYER_FAILURES.bluetooth };
        }
        case 'mfa': {
          const totp = input.totp ?? null;
          if (!config.mfa) return { id, ok: false, reason: LAYER_FAILURES.totp };
          return totp?.ok ? { id, ok: true } : { id, ok: false, reason: totp ? totp.reason : LAYER_FAILURES.totpMissing };
        }
      }
    });
    return { ok: layers.every(layer => layer.ok), layers, enforced };
  } catch {
    return { ok: false, layers: ordered.map(id => ({ id, ok: false, reason: LAYER_FAILURES.unchecked })), enforced };
  }
}

// ---------------------------------------------------------------------------
// GET /solana/layers
// ---------------------------------------------------------------------------

export type ItemState = 'active' | 'pending-addition' | 'pending-removal';
export interface LayerItemView {
  id: string; type: 'passkey' | 'zone' | 'network' | 'radio' | 'bluetooth' | 'authenticator'; label: string; detail: string; state: ItemState;
  since?: string; effectiveAt?: string; changeId?: string;
}
export interface LayerView {
  id: LayerId; kinds: LayerKind[]; status: 'enrolled' | 'not-enrolled' | 'pending-removal'; enforced: boolean;
  items: LayerItemView[]; mode?: 'network' | 'network+radio'; changeId?: string; effectiveAt?: string;
  /** Limits only: the caps the user set (raw units; null = no cap). All null while Limits is off. */
  limits?: { perReleaseRaw: AssetCapRaw; perDayRaw: AssetCapRaw };
}
export interface DeviceView { keyId: string; label: string; surface: Surface; state: ItemState; since?: string; effectiveAt?: string; changeId?: string }
export interface PendingView { id: string; class: 'loosen' | 'recovery'; summary: string; label?: string; requestedAt: string; effectiveAt: string; waived: OptionalLayerId[] }

export const maskBssid = (bssid: string) => `••:••:••:••:${bssid.slice(-5)}`;
/** The Limits layer view: optional and off by default; when on, the caps the user set (null = no cap for that value). */
function limitsView(config: VaultLayerConfig | null, off: PendingChange | undefined): LayerView {
  const on = config?.limits != null;
  const caps = rawCaps(effectiveReleaseLimits(config?.limits ?? null));
  return {
    id: 'limits', kinds: ['cryptographic'], status: !on ? 'not-enrolled' : off ? 'pending-removal' : 'enrolled', enforced: on, items: [],
    ...(on && off ? { changeId: off.id, effectiveAt: off.effectiveAt } : {}),
    limits: { perReleaseRaw: { ...caps.perReleaseRaw }, perDayRaw: { ...caps.perDayRaw } },
  };
}

/**
 * The GET view of an effective configuration. Never returns zone centers, full
 * IPs, full BSSIDs, Bluetooth identifiers, keys or authenticator secrets.
 * Biometrics is always enforced: `not-enrolled` with `enforced: true` means
 * releases are paused until a passkey is added. MFA is the vault's own
 * authenticator and, like the other optional layers, is enforced only when on.
 * Limits is enforced only while the user has set at least one cap.
 */
export function describeLayers(input: {
  config: VaultLayerConfig | null; network: NetworkObservation;
}): { configVersion: number; network: { observed: boolean; trusted: boolean | null }; layers: LayerView[]; devices: DeviceView[]; pending: PendingView[] } {
  const config = input.config;
  const pending = config?.pending ?? [];
  const removal = new Map<string, PendingChange>(), addition: PendingChange[] = [];
  for (const change of pending) {
    const key = targetKey(change.op);
    if (key && !removal.has(key)) removal.set(key, change);
    if (/\.add/.test(change.op.type) && change.op.type !== 'wifi.add-bssid') addition.push(change);
  }
  // A layer is pending removal when the pending changes, applied in order, would turn it off.
  const turnsOff = new Map<DisableableLayerId, PendingChange>();
  if (config) {
    let after = config;
    for (const change of pending) {
      try { after = applyChange(after, change.op); } catch { continue; }
      for (const id of [...OPTIONAL_LAYER_IDS, 'limits'] as const) if (config[id] !== null && after[id] === null && !turnsOff.has(id)) turnsOff.set(id, change);
    }
  }
  const itemState = (key: string, since: string): Pick<LayerItemView, 'state' | 'since' | 'effectiveAt' | 'changeId'> => {
    const change = removal.get(key);
    return change ? { state: 'pending-removal', since, effectiveAt: change.effectiveAt, changeId: change.id } : { state: 'active', since };
  };
  const added = (change: PendingChange): Pick<LayerItemView, 'state' | 'effectiveAt' | 'changeId'> => ({ state: 'pending-addition', effectiveAt: change.effectiveAt, changeId: change.id });
  // A passkey added (or being added) by a recovery change says so, so an owner can spot one they did not add.
  const passkeyDetail = (item: { deviceType: string; backedUp: boolean; surface: Surface; addedVia?: 'recovery' }, recovery = item.addedVia === 'recovery') =>
    `${item.deviceType === 'multiDevice' || item.backedUp ? 'Synced passkey' : 'Device-bound passkey'} · added from ${SURFACE_NAMES[item.surface]}${recovery ? ' · added through recovery' : ''}`;
  const radioDetail = (bssids: readonly string[]) => `Wi-Fi name with ${bssids.length} access point${bssids.length === 1 ? '' : 's'} · ${bssids.map(maskBssid).join(', ')}`;
  const bluetoothDetail = (item: { surface: Surface; identifier: string }) => `${SURFACE_NAMES[item.surface]} · ID …${item.identifier.slice(-4)}`;
  const authenticatorDetail = (recovery: boolean) => `Authenticator app · 6-digit codes, each used once${recovery ? ' · added through recovery' : ''}`;

  const items: Record<OptionalLayerId, LayerItemView[]> = {
    biometrics: [
      ...(config?.biometrics?.credentials ?? []).map(item => ({ id: item.id, type: 'passkey' as const, label: item.label, detail: passkeyDetail(item), ...itemState(`passkey:${item.id}`, item.addedAt) })),
      ...addition.flatMap(change => change.op.type === 'passkey.add'
        ? [{ id: change.op.credential.id, type: 'passkey' as const, label: change.op.credential.label, detail: passkeyDetail(change.op.credential, change.class === 'recovery'), ...added(change) }] : []),
    ],
    geolocation: [
      ...(config?.geolocation?.zones ?? []).map(item => ({ id: item.id, type: 'zone' as const, label: item.label, detail: `Radius ${item.radiusM} m`, ...itemState(`zone:${item.id}`, item.addedAt) })),
      ...addition.flatMap(change => change.op.type === 'geolocation.add-zone'
        ? [{ id: change.op.zone.id, type: 'zone' as const, label: change.op.zone.label, detail: `Radius ${change.op.zone.radiusM} m`, ...added(change) }] : []),
    ],
    wifi: [
      ...(config?.wifi?.networks ?? []).map(item => ({ id: item.id, type: 'network' as const, label: item.label, detail: maskCidr(item.cidr), ...itemState(`net:${item.id}`, item.addedAt) })),
      ...addition.flatMap(change => change.op.type === 'wifi.add-network'
        ? [{ id: change.op.network.id, type: 'network' as const, label: change.op.network.label, detail: maskCidr(change.op.network.cidr), ...added(change) }] : []),
      ...(config?.wifi?.radios ?? []).map(item => ({ id: item.id, type: 'radio' as const, label: item.label, detail: radioDetail(item.bssids), ...itemState(`radio:${item.id}`, item.addedAt) })),
      ...addition.flatMap(change => change.op.type === 'wifi.add-radio'
        ? [{ id: change.op.radio.id, type: 'radio' as const, label: change.op.radio.label, detail: radioDetail(change.op.radio.bssids), ...added(change) }] : []),
    ],
    bluetooth: [
      ...(config?.bluetooth?.devices ?? []).map(item => ({ id: item.id, type: 'bluetooth' as const, label: item.label, detail: bluetoothDetail(item), ...itemState(`bt:${item.id}`, item.addedAt) })),
      ...addition.flatMap(change => change.op.type === 'bluetooth.add-device'
        ? [{ id: change.op.device.id, type: 'bluetooth' as const, label: change.op.device.label, detail: bluetoothDetail(change.op.device), ...added(change) }] : []),
    ],
    mfa: [
      ...(config?.mfa ? [{ id: config.mfa.id, type: 'authenticator' as const, label: config.mfa.label, detail: authenticatorDetail(config.mfa.addedVia === 'recovery'), ...itemState(`totp:${config.mfa.id}`, config.mfa.addedAt) }] : []),
      ...addition.flatMap(change => change.op.type === 'mfa.add'
        ? [{ id: change.op.authenticator.id, type: 'authenticator' as const, label: change.op.authenticator.label, detail: authenticatorDetail(change.class === 'recovery'), ...added(change) }] : []),
    ],
  };
  const optional = (id: OptionalLayerId, kinds: LayerKind[]): LayerView => {
    const on = config !== null && config[id] !== null;
    const off = turnsOff.get(id);
    const view: LayerView = {
      id, kinds, status: !on ? 'not-enrolled' : off ? 'pending-removal' : 'enrolled',
      // Biometrics is mandatory: without a passkey, releases are paused.
      enforced: on || id === 'biometrics', items: items[id],
      ...(on && off ? { changeId: off.id, effectiveAt: off.effectiveAt } : {}),
    };
    if (id === 'wifi' && config?.wifi) view.mode = config.wifi.mode;
    return view;
  };
  const wifiKinds: LayerKind[] = config?.wifi?.mode === 'network+radio' ? ['server-observed', 'device-reported'] : ['server-observed'];
  const layers: LayerView[] = [
    optional('bluetooth', ['device-reported']),
    optional('wifi', wifiKinds),
    optional('biometrics', ['cryptographic']),
    optional('geolocation', ['device-reported']),
    // The vault authenticator: ANTARA checks a single-use 6-digit code against the sealed secret for each release.
    optional('mfa', ['cryptographic']),
    limitsView(config, turnsOff.get('limits')),
  ];
  const devices: DeviceView[] = [
    ...(config?.devices ?? []).map(item => ({ keyId: item.keyId, label: item.label, surface: item.surface, ...itemState(`device:${item.keyId}`, item.addedAt) })),
    ...addition.flatMap(change => change.op.type === 'device.add'
      ? [{ keyId: change.op.device.keyId, label: change.op.device.label, surface: change.op.device.surface, ...added(change) }] : []),
  ];
  const network = input.network;
  return {
    configVersion: config?.version ?? 0,
    network: {
      observed: network.status === 'public',
      trusted: config?.wifi ? network.status === 'public' && config.wifi.networks.some(item => cidrContains(item.cidr, network.ip)) : null,
    },
    layers,
    devices,
    pending: pending.map(change => {
      const label = changeLabel(change.op, config);
      return { id: change.id, class: change.class, summary: summariseChange(change.op), ...(label ? { label } : {}), requestedAt: change.requestedAt, effectiveAt: change.effectiveAt, waived: [...change.waived] };
    }),
  };
}
