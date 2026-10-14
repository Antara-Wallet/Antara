/**
 * Strict parsers for the vault layer API (docs/VAULT_LAYERS.md section 9). Anything
 * unexpected throws, so the wallet never shows a layer status, badge or item it
 * could not check: unknown layers, kinds, statuses or fields, an "enforced" flag on
 * a layer that is not enrolled, a badge the layer cannot honestly carry, or a value
 * that looks unmasked (a full IP address, access point, identifier or coordinate).
 */
import { isSolanaAddress, parseTransactionIndex } from '../paired/solanaDecode';
import { expectedKinds } from './claims';
import {
  LAYER_IDS, LAYER_KINDS, OPTIONAL_LAYER_IDS, SURFACES, isOptionalLayer,
  type BluetoothMatch, type CancelResult, type ChangeCapture, type ChangeChallenge, type ChangeClass, type ChangeResult, type ItemState, type LayerId,
  type LayerItem, type LayerKind, type LayerLimitsView, type LayerRequirement, type LayerResult, type LayerStatus, type LayerView, type OptionalLayerId,
  type PendingChangeNotice, type PendingChangeView,
  type PerAssetCap, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type ReleaseChallenge, type Surface,
  type TrustedDeviceView, type VaultLayersView, type WifiMode,
} from './types';

const invalid = (): never => { throw new Error('The vault service returned an unexpected layer response. Nothing was changed.'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
/** Refuses any key outside `allowed`, so new server fields (a zone center, a full address) are never silently passed through. */
function strict(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  const item = record(value);
  for (const key of Object.keys(item)) if (!allowed.includes(key)) invalid();
  for (const key of required) if (!(key in item)) invalid();
  return item;
}
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid();
const text = (value: unknown, max: number, min = 1): string => typeof value === 'string' && value.length >= min && value.length <= max ? value : invalid();
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T => typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : invalid();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const iso = (value: unknown): number => {
  const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : invalid();
};
const optionalIso = (value: unknown): number | null => value === undefined || value === null ? null : iso(value);
const version = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const RAW = /^(0|[1-9]\d{0,30})$/;
const raw = (value: unknown): bigint => typeof value === 'string' && RAW.test(value) ? BigInt(value) : invalid();
const ID = /^[A-Za-z0-9_-]{1,1400}$/;
const id = (value: unknown): string => typeof value === 'string' && ID.test(value) ? value : invalid();
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const keyId = (value: unknown): string => typeof value === 'string' && KEY_ID.test(value) ? value : invalid();
const CHANGE_ID = /^chg_[A-Za-z0-9_-]{1,40}$/;
const changeId = (value: unknown): string => typeof value === 'string' && CHANGE_ID.test(value) ? value : invalid();
const optionalChangeId = (value: unknown): string | null => value === undefined || value === null ? null : changeId(value);
const CHALLENGE_ID = /^[A-Za-z0-9_-]{22}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Values the server must never return unmasked (section 9.1, "Never returned"). */
const UNMASKED = [
  /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/, // a full IPv4 address
  /(?:[0-9a-f]{1,4}:){4,}/i, // a full-looking IPv6 address
  /(?<![0-9a-f])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}(?![0-9a-f])/i, // a full BSSID or Bluetooth address
  /(?<![0-9a-z])[0-9a-f]{12}(?![0-9a-z])/i, // a 12-hex identifier
  /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/, // a coordinate pair
];
export function looksUnmasked(value: string) { return UNMASKED.some(pattern => pattern.test(value)); }
const masked = (value: unknown, max: number): string => { const out = text(value, max, 0); return looksUnmasked(out) ? invalid() : out; };

function parseItem(value: unknown): LayerItem {
  const item = strict(value, ['id', 'type', 'label', 'detail', 'state', 'since', 'effectiveAt', 'changeId'], ['id', 'type', 'label', 'detail', 'state']);
  const state = oneOf<ItemState>(item.state, ['active', 'pending-addition', 'pending-removal']);
  const parsed: LayerItem = {
    id: id(item.id), type: typeof item.type === 'string' && /^[a-z][a-z-]{0,31}$/.test(item.type) ? item.type : invalid(),
    label: text(item.label, 64), detail: masked(item.detail, 160), state,
    since: optionalIso(item.since), effectiveAt: optionalIso(item.effectiveAt), changeId: optionalChangeId(item.changeId),
  };
  // A pending item always names the change that would apply it, and when.
  if (state !== 'active' && (parsed.effectiveAt === null || parsed.changeId === null)) invalid();
  return parsed;
}

const CAP = /^[1-9]\d{0,30}$/;
const cap = (value: unknown): bigint | null => value === null ? null : typeof value === 'string' && CAP.test(value) ? BigInt(value) : invalid();
const perAssetCap = (value: unknown): PerAssetCap => { const item = strict(value, ['SOL', 'USDC']); return { SOL: cap(item.SOL), USDC: cap(item.USDC) }; };
/** The caps the user set (null = no cap); a per-release cap is never above that asset's daily cap. No server ceiling or minimum exists. */
function parseLimits(value: unknown): LayerLimitsView {
  const item = strict(value, ['perReleaseRaw', 'perDayRaw']);
  const limits = { perRelease: perAssetCap(item.perReleaseRaw), perDay: perAssetCap(item.perDayRaw) };
  for (const asset of ['SOL', 'USDC'] as const) {
    const once = limits.perRelease[asset], day = limits.perDay[asset];
    if (once !== null && day !== null && once > day) invalid();
  }
  return limits;
}
const anyCap = (limits: LayerLimitsView) => [limits.perRelease.SOL, limits.perRelease.USDC, limits.perDay.SOL, limits.perDay.USDC].some(value => value !== null);

function parseLayer(value: unknown, expectedId: LayerId): LayerView {
  const item = strict(value, ['id', 'kinds', 'status', 'enforced', 'items', 'mode', 'changeId', 'effectiveAt', 'limits'], ['id', 'kinds', 'status', 'enforced', 'items']);
  if (item.id !== expectedId) invalid();
  const status = oneOf<LayerStatus>(item.status, ['enrolled', 'not-enrolled', 'pending-removal']);
  const enforced = bool(item.enforced);
  const items = list(item.items, 16).map(parseItem);
  const mode = item.mode === undefined || item.mode === null ? null : oneOf<WifiMode>(item.mode, ['network', 'network+radio']);
  const kinds = list(item.kinds, 3).map(kind => oneOf<LayerKind>(kind, LAYER_KINDS));
  const layer: LayerView = {
    id: expectedId, kinds, status, enforced, items, mode, changeId: optionalChangeId(item.changeId), effectiveAt: optionalIso(item.effectiveAt),
    limits: item.limits === undefined || item.limits === null ? null : parseLimits(item.limits),
  };
  // Badges are bound to what each layer is, never to what the server says it is.
  const allowed = expectedKinds(expectedId, mode);
  if (kinds.length !== allowed.length || kinds.some((kind, index) => kind !== allowed[index])) invalid();
  if (mode !== null && expectedId !== 'wifi') invalid();
  if (layer.limits !== null && expectedId !== 'limits') invalid();
  const active = items.some(entry => entry.state !== 'pending-addition');
  if (isOptionalLayer(expectedId)) {
    // "enforced" exactly when enrolled or pending removal; "enrolled" needs an item that is in force now.
    // Biometrics may also be enforced while not enrolled: a passkey is required for every vault (owner decision),
    // so that answer means releases are paused until one is added. MFA (the vault authenticator) follows the optional rules.
    if (enforced !== (status !== 'not-enrolled') && !(expectedId === 'biometrics' && status === 'not-enrolled' && enforced)) invalid();
    if (status === 'not-enrolled' ? active || mode !== null : !active) invalid();
    if (expectedId === 'wifi' && status !== 'not-enrolled' && mode === null) invalid();
    if (status === 'pending-removal' ? layer.changeId === null || layer.effectiveAt === null : layer.changeId !== null || layer.effectiveAt !== null) invalid();
  } else {
    // Limits is optional and off by default. It always carries its caps (all null while off), is enforced exactly when the
    // user set one, and has no items. It can be pending removal only through a recovery change.
    if (layer.limits === null || items.length || enforced !== (status !== 'not-enrolled') || anyCap(layer.limits) !== (status !== 'not-enrolled')) invalid();
    if (status === 'pending-removal' ? layer.changeId === null || layer.effectiveAt === null : layer.changeId !== null || layer.effectiveAt !== null) invalid();
  }
  return layer;
}

function parseDevice(value: unknown): TrustedDeviceView {
  const item = strict(value, ['keyId', 'label', 'surface', 'state', 'since', 'effectiveAt', 'changeId'], ['keyId', 'label', 'surface', 'state']);
  const device: TrustedDeviceView = {
    keyId: keyId(item.keyId), label: text(item.label, 64), surface: oneOf<Surface>(item.surface, SURFACES),
    state: oneOf<ItemState>(item.state, ['active', 'pending-addition', 'pending-removal']),
    since: optionalIso(item.since), effectiveAt: optionalIso(item.effectiveAt), changeId: optionalChangeId(item.changeId),
  };
  if (device.state !== 'active' && (device.effectiveAt === null || device.changeId === null)) invalid();
  return device;
}

const waivedLayers = (value: unknown): OptionalLayerId[] => {
  const waived = list(value, OPTIONAL_LAYER_IDS.length).map(layer => oneOf(layer, OPTIONAL_LAYER_IDS));
  return new Set(waived).size === waived.length ? waived : invalid();
};

/**
 * The summary may quote a label the user chose (any printable text), so it is not run through the
 * unmasked-value check: a label such as "Office 10.0.0.1" must never hide a pending change and its Cancel.
 * Only server-generated fields (item details, the observed network, failure reasons) are checked.
 */
function parsePending(value: unknown): PendingChangeView {
  const item = strict(value, ['id', 'class', 'summary', 'label', 'requestedAt', 'effectiveAt', 'waived'], ['id', 'class', 'summary', 'requestedAt', 'effectiveAt', 'waived']);
  const change: PendingChangeView = {
    id: changeId(item.id), class: oneOf<'loosen' | 'recovery'>(item.class, ['loosen', 'recovery']), summary: text(item.summary, 200),
    label: item.label === undefined || item.label === null ? null : text(item.label, 64),
    requestedAt: iso(item.requestedAt), effectiveAt: iso(item.effectiveAt), waived: waivedLayers(item.waived),
  };
  if ((change.class === 'recovery') !== (change.waived.length > 0) || change.effectiveAt <= change.requestedAt) invalid();
  return change;
}

/**
 * Fallback when GET /solana/layers answered 200 but the full view could not be checked: the pending
 * changes alone (id, class, effective time), so the wallet can still warn and offer Cancel without
 * showing any layer status. Bound to the vault asked for; null when even these cannot be read.
 */
export function parsePendingNotices(value: unknown, multisig: string): PendingChangeNotice[] | null {
  try {
    const item = record(value);
    if (item.multisig !== multisig || !isSolanaAddress(item.multisig)) return null;
    const notices = list(item.pending, 5).map((entry): PendingChangeNotice => {
      const change = record(entry);
      let waived: OptionalLayerId[] | null = null;
      try { waived = waivedLayers(change.waived); } catch { waived = null; }
      return { id: changeId(change.id), class: oneOf<'loosen' | 'recovery'>(change.class, ['loosen', 'recovery']), effectiveAt: iso(change.effectiveAt), waived };
    });
    return new Set(notices.map(notice => notice.id)).size === notices.length ? notices : null;
  } catch { return null; }
}

/** GET /solana/layers answered, but not with a view the wallet can show. Carries any pending changes it could still read. */
export class LayerViewError extends Error {
  constructor(message: string, readonly pending: PendingChangeNotice[]) { super(message); this.name = 'LayerViewError'; }
}

/** GET /solana/layers. Bound to the vault that was asked for. */
export function parseVaultLayers(value: unknown, multisig: string): VaultLayersView {
  const item = strict(value, ['multisig', 'configVersion', 'serverTime', 'network', 'layers', 'devices', 'pending']);
  if (item.multisig !== multisig || !isSolanaAddress(item.multisig)) invalid();
  const network = strict(item.network, ['observed', 'trusted']);
  const layers = list(item.layers, LAYER_IDS.length);
  if (layers.length !== LAYER_IDS.length) invalid();
  const parsed: VaultLayersView = {
    multisig, configVersion: version(item.configVersion), serverTime: iso(item.serverTime),
    network: { observed: bool(network.observed), trusted: network.trusted === null ? null : bool(network.trusted) },
    layers: layers.map((layer, index) => parseLayer(layer, LAYER_IDS[index])),
    devices: list(item.devices, 10).map(parseDevice),
    pending: list(item.pending, 5).map(parsePending),
  };
  const ids = [...parsed.devices.map(device => device.keyId), ...parsed.pending.map(change => change.id)];
  if (new Set(ids).size !== ids.length) invalid();
  for (const layer of parsed.layers) if (new Set(layer.items.map(entry => entry.id)).size !== layer.items.length) invalid();
  const wifi = parsed.layers[1];
  if (wifi.status === 'not-enrolled' && parsed.network.trusted !== null) invalid();
  return parsed;
}

// ---- Requirements, challenges, results -------------------------------------------------------

const BLUETOOTH_CLASSIC = /^[0-9A-F]{12}$/;
function parseMatch(value: unknown): BluetoothMatch {
  const item = strict(value, ['surface', 'source', 'identifier', 'name']);
  const surface = oneOf<Surface>(item.surface, SURFACES);
  const source = oneOf<'windows-classic' | 'web-bluetooth'>(item.source, ['windows-classic', 'web-bluetooth']);
  if ((surface === 'desktop') !== (source === 'windows-classic')) invalid();
  const identifier = text(item.identifier, 64);
  if (source === 'windows-classic' && !BLUETOOTH_CLASSIC.test(identifier)) invalid();
  return { surface, source, identifier, name: text(item.name, 64, 0) };
}

function parseRequirement(value: unknown): LayerRequirement {
  const item = strict(value, ['id', 'evidence', 'reading', 'match', 'desktopOnly'], ['id', 'evidence']);
  const layerId = oneOf<LayerId>(item.id, LAYER_IDS);
  const evidence = oneOf<LayerRequirement['evidence']>(item.evidence, ['passkey', 'device', 'server', 'totp']);
  const reading = item.reading === undefined ? null : oneOf<'geo' | 'bluetooth' | 'wifi'>(item.reading, ['geo', 'bluetooth', 'wifi']);
  const match = item.match === undefined ? [] : list(item.match, 16).map(parseMatch);
  const desktopOnly = item.desktopOnly === undefined ? false : item.desktopOnly === true ? true : invalid();
  const shape = `${layerId}:${evidence}:${reading ?? ''}`;
  // 'mfa:server:' is the pre-2026-10-13 shape (nothing to collect); 'mfa:totp:' asks for a vault authenticator code.
  const allowed = ['biometrics:passkey:', 'geolocation:device:geo', 'bluetooth:device:bluetooth', 'wifi:server:', 'wifi:device:wifi', 'mfa:server:', 'mfa:totp:', 'limits:server:'];
  if (!allowed.includes(shape)) invalid();
  if ((layerId === 'bluetooth') !== (item.match !== undefined)) invalid();
  if ((shape === 'wifi:device:wifi') !== desktopOnly) invalid();
  return { id: layerId, evidence, reading, match, desktopOnly };
}

export function parseLayerRequirements(value: unknown): LayerRequirement[] {
  const required = list(value, 8).map(parseRequirement);
  const keys = required.map(item => `${item.id}:${item.evidence}`);
  if (new Set(keys).size !== keys.length) invalid();
  return required;
}

export function parseLayerResults(value: unknown): LayerResult[] {
  const results = list(value, LAYER_IDS.length).map(entry => {
    const item = strict(entry, ['id', 'ok', 'reason'], ['id', 'ok']);
    const ok = bool(item.ok);
    return { id: oneOf<LayerId>(item.id, LAYER_IDS), ok, reason: item.reason === undefined || item.reason === null ? null : masked(item.reason, 300) };
  });
  if (new Set(results.map(item => item.id)).size !== results.length) invalid();
  return results;
}

function parseDescriptor(value: unknown) {
  const item = strict(value, ['id', 'type', 'transports'], ['id', 'type']);
  if (item.type !== 'public-key' || typeof item.id !== 'string' || !B64URL.test(item.id) || item.id.length > 1400) invalid();
  const transports = item.transports === undefined ? undefined : list(item.transports, 8).map(transport =>
    oneOf(transport, ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const));
  return transports ? { id: item.id as string, type: 'public-key' as const, transports } : { id: item.id as string, type: 'public-key' as const };
}
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const timeout = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 30_000 && value <= 180_000 ? value : invalid();

/** Request options must require user verification and name at least one credential (section 6.2). */
export function parseRequestOptions(value: unknown): PublicKeyCredentialRequestOptionsJSON {
  const item = strict(value, ['challenge', 'rpId', 'allowCredentials', 'userVerification', 'timeout']);
  if (typeof item.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.challenge)) invalid();
  if (typeof item.rpId !== 'string' || !DOMAIN.test(item.rpId) || item.userVerification !== 'required') invalid();
  const allowCredentials = list(item.allowCredentials, 16).map(parseDescriptor);
  if (!allowCredentials.length) invalid();
  return { challenge: item.challenge as string, rpId: item.rpId as string, allowCredentials, userVerification: 'required', timeout: timeout(item.timeout) };
}

/** Creation options must require user verification, ask for no attestation and offer only ES256 and RS256 (section 9.4). */
export function parseCreationOptions(value: unknown): PublicKeyCredentialCreationOptionsJSON {
  const item = strict(value, ['rp', 'user', 'challenge', 'pubKeyCredParams', 'authenticatorSelection', 'attestation', 'excludeCredentials', 'timeout'], ['rp', 'user', 'challenge', 'pubKeyCredParams', 'authenticatorSelection', 'attestation', 'timeout']);
  const rp = strict(item.rp, ['id', 'name']);
  const user = strict(item.user, ['id', 'name', 'displayName']);
  const selection = strict(item.authenticatorSelection, ['residentKey', 'userVerification', 'requireResidentKey'], ['userVerification']);
  if (typeof rp.id !== 'string' || !DOMAIN.test(rp.id) || typeof item.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.challenge)) invalid();
  if (typeof user.id !== 'string' || !B64URL.test(user.id) || user.id.length > 88 || selection.userVerification !== 'required' || item.attestation !== 'none') invalid();
  if (selection.residentKey !== undefined) oneOf(selection.residentKey, ['discouraged', 'preferred', 'required']);
  if (selection.requireResidentKey !== undefined) bool(selection.requireResidentKey);
  const params = list(item.pubKeyCredParams, 4).map(entry => {
    const param = strict(entry, ['type', 'alg']);
    if (param.type !== 'public-key' || (param.alg !== -7 && param.alg !== -257)) invalid();
    return { type: 'public-key' as const, alg: param.alg as number };
  });
  if (!params.length) invalid();
  return {
    rp: { id: rp.id as string, name: text(rp.name, 64) },
    user: { id: user.id as string, name: text(user.name, 128), displayName: text(user.displayName, 128) },
    challenge: item.challenge as string, pubKeyCredParams: params,
    authenticatorSelection: {
      ...(selection.residentKey === undefined ? {} : { residentKey: selection.residentKey as ResidentKeyRequirement }),
      ...(selection.requireResidentKey === undefined ? {} : { requireResidentKey: selection.requireResidentKey as boolean }),
      userVerification: 'required',
    },
    attestation: 'none', excludeCredentials: item.excludeCredentials === undefined ? [] : list(item.excludeCredentials, 16).map(parseDescriptor),
    timeout: timeout(item.timeout),
  };
}

function challengeBase(item: Record<string, unknown>) {
  if (typeof item.challengeId !== 'string' || !CHALLENGE_ID.test(item.challengeId) || typeof item.nonce !== 'string' || !NONCE.test(item.nonce) ||
    typeof item.digest !== 'string' || !DIGEST.test(item.digest)) invalid();
  const required = parseLayerRequirements(item.required);
  const devices = list(item.devices, 10).map(entry => { const device = strict(entry, ['keyId', 'surface']); return { keyId: keyId(device.keyId), surface: oneOf<Surface>(device.surface, SURFACES) }; });
  return {
    challengeId: item.challengeId as string, expiresAt: iso(item.expiresAt), nonce: item.nonce as string, digest: item.digest as string,
    configVersion: version(item.configVersion), required, devices,
  };
}

/** POST /solana/layers/approval/begin, bound to the vault and proposal index that were asked for. */
export function parseReleaseChallenge(value: unknown, multisig: string, transactionIndex: string): ReleaseChallenge {
  const item = strict(value, ['challengeId', 'expiresAt', 'purpose', 'nonce', 'digest', 'configVersion', 'release', 'required', 'devices', 'webauthn']);
  if (item.purpose !== 'release') invalid();
  const release = strict(item.release, ['multisig', 'transactionIndex', 'asset', 'amountRaw', 'recipient']);
  if (release.multisig !== multisig || release.transactionIndex !== transactionIndex || !isSolanaAddress(release.recipient)) invalid();
  try { parseTransactionIndex(release.transactionIndex); } catch { invalid(); }
  const base = challengeBase(item);
  const biometrics = base.required.some(requirement => requirement.evidence === 'passkey');
  const webauthn = item.webauthn === null ? null : parseRequestOptions(item.webauthn);
  if (biometrics !== (webauthn !== null)) invalid();
  return {
    ...base, purpose: 'release', webauthn,
    release: { multisig, transactionIndex, asset: oneOf(release.asset, ['SOL', 'USDC'] as const), amountRaw: raw(release.amountRaw).toString(), recipient: release.recipient as string },
  };
}

/** POST /solana/layers/enroll/begin and /change/begin. */
export function parseChangeChallenge(value: unknown, kind: 'enroll' | 'change'): ChangeChallenge {
  const item = strict(value, ['challengeId', 'expiresAt', 'purpose', 'nonce', 'digest', 'configVersion', 'class', 'effectiveAt', 'required', 'devices', 'webauthn', 'capture'],
    ['challengeId', 'expiresAt', 'purpose', 'nonce', 'digest', 'configVersion', 'class', 'effectiveAt', 'required', 'devices', 'webauthn']);
  if (item.purpose !== 'change') invalid();
  const base = challengeBase(item);
  const changeClass = oneOf<ChangeClass>(item.class, ['tighten', 'loosen', 'recovery']);
  const effectiveAt = item.effectiveAt === null ? null : iso(item.effectiveAt);
  // Owner decision 2026-10-13: tighten and loosen apply at once (null); only a recovery change waits. A server from before then
  // may still name a time for a loosening, which is accepted and shown as such.
  if ((changeClass === 'tighten' && effectiveAt !== null) || (changeClass === 'recovery' && effectiveAt === null)) invalid();
  const webauthnItem = strict(item.webauthn, ['get', 'create']);
  const get = webauthnItem.get === null ? null : parseRequestOptions(webauthnItem.get);
  const create = webauthnItem.create === null ? null : parseCreationOptions(webauthnItem.create);
  if (kind === 'change' && create !== null) invalid();
  if (base.required.some(requirement => requirement.evidence === 'passkey') !== (get !== null)) invalid();
  let capture: ChangeCapture = { geo: false, wifi: false, bluetooth: false, network: null, totp: null };
  if (item.capture !== undefined && item.capture !== null) {
    if (kind === 'change') invalid();
    const entry = strict(item.capture, ['geo', 'wifi', 'bluetooth', 'network', 'totp'], []);
    const totp = entry.totp === undefined ? null : strict(entry.totp, ['secret']);
    capture = {
      geo: entry.geo === undefined ? false : entry.geo === true ? true : invalid(),
      wifi: entry.wifi === undefined ? false : entry.wifi === true ? true : invalid(),
      bluetooth: entry.bluetooth === undefined ? false : entry.bluetooth === 'choose' ? true : invalid(),
      network: entry.network === undefined ? null : { observedCidr: masked(strict(entry.network, ['observedCidr']).observedCidr, 64) },
      // A 20-byte RFC 6238 secret in base32: exactly what an authenticator app accepts.
      totp: totp === null ? null : { secret: typeof totp.secret === 'string' && /^[A-Z2-7]{32}$/.test(totp.secret) ? totp.secret : invalid() },
    };
  }
  return { ...base, purpose: 'change', class: changeClass, effectiveAt, webauthn: { get, create }, capture };
}

export function parseChangeResult(value: unknown): ChangeResult {
  const item = record(value);
  if (item.status === 'applied') { strict(item, ['status', 'configVersion']); return { status: 'applied', configVersion: version(item.configVersion) }; }
  strict(item, ['status', 'change']);
  if (item.status !== 'pending') invalid();
  const change = strict(item.change, ['id', 'class', 'effectiveAt']);
  return { status: 'pending', change: { id: changeId(change.id), class: oneOf<'loosen' | 'recovery'>(change.class, ['loosen', 'recovery']), effectiveAt: iso(change.effectiveAt) } };
}

export function parseCancelResult(value: unknown): CancelResult {
  const item = strict(value, ['status', 'configVersion']);
  if (item.status !== 'cancelled') invalid();
  return { status: 'cancelled', configVersion: version(item.configVersion) };
}

/**
 * Extra fields of a refusal (section 9.3). Malformed extras are dropped, never trusted.
 * The lockout time comes from `Retry-After`, or from `retryAfterSeconds` in the body: a cross-origin
 * caller (ANTARA Desktop, the extension) cannot read the header unless the server exposes it.
 */
export function parseLayerRefusal(code: string, body: Record<string, unknown>, retryAfter: string | null) {
  const safe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
  const fromBody = body.retryAfterSeconds;
  const seconds = retryAfter !== null && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter)
    : typeof fromBody === 'number' && Number.isSafeInteger(fromBody) && fromBody <= 99_999 ? fromBody : null;
  return {
    required: code === 'layers-required' && body.required !== undefined ? safe(() => parseLayerRequirements(body.required)) : null,
    layers: code === 'layer-failed' && body.layers !== undefined ? safe(() => parseLayerResults(body.layers)) : null,
    retryAfterSeconds: code === 'locked' && seconds !== null && seconds > 0 ? seconds : null,
  };
}
