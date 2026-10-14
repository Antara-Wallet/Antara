/**
 * Vault protection layers (docs/VAULT_LAYERS.md): shared types and limits.
 *
 * The six layers on the public landing page gate the guardian's (G's) vote on
 * a paired-vault release. Every enabled layer fails closed, all evidence is
 * bound to one exact proposal or change, and each layer says honestly what it
 * is: cryptographic, device-reported or server-observed.
 */
import type { SealedTotpSecret } from './totp.js';

/** Landing order (src/solares/landing/protectionLayers.ts); GET /solana/layers always lists all six in this order. */
export const LAYER_IDS = Object.freeze(['bluetooth', 'wifi', 'biometrics', 'geolocation', 'mfa', 'limits'] as const);
export type LayerId = typeof LAYER_IDS[number];
/**
 * Evidence-bearing layers a user can enroll, turn off or waive. MFA is ANTARA's own vault
 * authenticator (owner decision 2026-10-13), optional like Bluetooth, Wi-Fi and location.
 * Limits is optional too and off by default (owner decision 2026-10-13): it carries no evidence,
 * so it is set or turned off with its own changes (limits.set, layer.disable) and is never waived.
 */
export const OPTIONAL_LAYER_IDS = Object.freeze(['bluetooth', 'wifi', 'biometrics', 'geolocation', 'mfa'] as const);
export type OptionalLayerId = typeof OPTIONAL_LAYER_IDS[number];
export const SURFACES = Object.freeze(['desktop', 'extension', 'web'] as const);
export type Surface = typeof SURFACES[number];
export type LayerKind = 'cryptographic' | 'device-reported' | 'server-observed';
export type WifiMode = 'network' | 'network+radio';
export type BluetoothSource = 'windows-classic' | 'web-bluetooth';
/**
 * tighten: applies at once with the passkey. loosen: applies at once but needs every layer that is on
 * (owner decision 2026-10-13 removed the 24-hour wait). recovery: waives a layer the user can no longer
 * satisfy, so it waits RECOVERY_DELAY_MS and can be cancelled until then.
 */
export type ChangeClass = 'tighten' | 'loosen' | 'recovery';
/** A layer that can be turned off with layer.disable: an evidence-bearing optional layer, or Limits. */
export type DisableableLayerId = OptionalLayerId | 'limits';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Owner decision O1: a change that waives a layer the user can no longer satisfy waits seven days (lost-device recovery). */
export const RECOVERY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
/** A reservation whose layers passed this recently may be re-signed without new evidence (a Privy signing retry). */
export const RELEASE_RETRY_MS = 30 * 60 * 1000;
/**
 * A vault's first passkey applies at once only from the Privy session that
 * registered the vault, within this long of the registration. Any other first
 * passkey is a 7-day recovery change, so a stolen session cannot claim a vault
 * before its owner adds a passkey.
 */
export const ACTIVATION_WINDOW_MS = 15 * 60 * 1000;
/** How long a release that passed its layers may wait for the guardian's reservation (vaultStore.ts). */
export const RELEASE_AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
/** Device clocks may drift this much either way from the server's challenge window. */
export const CLOCK_SKEW_MS = 120_000;
export const MAX_PENDING_CHANGES = 5;
export const HISTORY_LIMIT = 50;
export const LOCKOUT = Object.freeze({ failures: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
export const CHALLENGE_LIMITS = Object.freeze({ perUser: 10, total: 10_000 });
export const ITEM_LIMITS = Object.freeze({ passkeys: 5, zones: 3, networks: 3, radios: 3, bssids: 8, bluetooth: 3, devices: 5 });
export const RADIUS_BOUNDS_M = Object.freeze({ min: 100, max: 50_000 });
export const PREFIX_BOUNDS = Object.freeze({ ipv4: { min: 24, max: 32, default: 32 }, ipv6: { min: 48, max: 128, default: 64 } });
/** Decoded device payload bytes, and the whole evidence object as JSON. */
export const PAYLOAD_MAX_BYTES = 4096;
export const EVIDENCE_MAX_BYTES = 16_384;
export const LABEL_MAX = 40;
export const PASSKEY_TIMEOUT_MS = 120_000;
export const WEBAUTHN_ALGORITHMS = Object.freeze([-7, -257]);

export interface AssetRaw { SOL: string; USDC: string }
/** One optional cap per asset, in raw units; null means no cap. */
export interface AssetCapRaw { SOL: string | null; USDC: string | null }
/** The caps a user set through the Limits layer; stored only while at least one value is set. */
export interface VaultLimitsRecord { perReleaseRaw: AssetCapRaw; perDayRaw: AssetCapRaw }

export interface PasskeyCredentialRecord {
  /** base64url credential id (at most 1024 bytes decoded). */
  id: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  /** RP ID at registration; it must equal the configured RP ID to verify. */
  rpId: string;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  /** A synced passkey when true. */
  backedUp: boolean;
  aaguid: string;
  /** From the registration origin. */
  surface: Surface;
  label: string;
  addedAt: string;
  /** Present when it was added by a recovery change (applied without the Biometrics evidence). */
  addedVia?: 'recovery';
}
export interface TrustedDeviceRecord {
  keyId: string; publicKeySpki: string; surface: Surface; label: string; addedAt: string;
  /** Present when it was added by a recovery change. */
  addedVia?: 'recovery';
}
/**
 * Whether a vault's first passkey may apply at once (docs/VAULT_LAYERS.md §8.1):
 * - `session`: this request comes from the Privy session that registered the vault, within ACTIVATION_WINDOW_MS
 * - `other-session`: the window is open for another session; this one is refused until it closes
 * - `none`: no open window (it expired, or the server restarted); a first passkey is a 7-day recovery change
 */
export type ActivationState = 'session' | 'other-session' | 'none';
/**
 * The vault's own authenticator app (MFA layer, RFC 6238 TOTP). The secret is stored only
 * sealed (layers/totp.ts). `lastStep` is the last 30-second step whose code was accepted:
 * a code for that step or any earlier one is refused (single use).
 */
export interface TotpAuthenticatorRecord {
  /** "totp_" + base64url(12 random bytes). */
  id: string;
  label: string;
  secret: SealedTotpSecret;
  lastStep: number;
  addedAt: string;
  /** Present when it was added by a recovery change. */
  addedVia?: 'recovery';
}
export interface SafeZoneRecord { id: string; label: string; lat: number; lng: number; radiusM: number; addedAt: string }
export interface TrustedNetworkRecord { id: string; label: string; cidr: string; addedAt: string }
export interface WifiRadioRecord { id: string; label: string; ssid: string; ssidHex: string; bssids: string[]; addedAt: string }
export interface BluetoothDeviceRecord {
  id: string; label: string; surface: Surface; source: BluetoothSource;
  /** windows-classic: 12 uppercase hex; web-bluetooth: Chrome's per-origin device.id. */
  identifier: string;
  /** As reported; the Web Bluetooth requestDevice filter. */
  name: string;
  addedAt: string;
}

/** A change as the client requests it (normalised; see normaliseOp for key order). */
export type ChangeOp =
  | { type: 'passkey.add'; label: string }
  | { type: 'passkey.remove'; credentialId: string }
  | { type: 'device.add'; label: string; surface: Surface; publicKeySpki: string }
  | { type: 'device.remove'; keyId: string }
  | { type: 'geolocation.add-zone'; label: string; radiusM: number; center: 'current' | { lat: number; lng: number } }
  | { type: 'geolocation.remove-zone'; zoneId: string }
  | { type: 'wifi.add-network'; label: string; prefixLength?: number; cidr?: string }
  | { type: 'wifi.remove-network'; networkId: string }
  | { type: 'wifi.add-radio'; label: string }
  | { type: 'wifi.add-bssid'; radioId: string }
  | { type: 'wifi.remove-radio'; radioId: string }
  | { type: 'wifi.set-mode'; mode: WifiMode }
  | { type: 'bluetooth.add-device'; label: string }
  | { type: 'bluetooth.remove-device'; deviceId: string }
  /** Each value a positive raw amount or null (no cap); all four null turns Limits off. */
  | { type: 'limits.set'; perReleaseRaw: AssetCapRaw; perDayRaw: AssetCapRaw }
  | { type: 'mfa.add'; label: string }
  | { type: 'layer.disable'; layer: DisableableLayerId };
export type ChangeOpType = ChangeOp['type'];
/** Ops accepted by the enroll routes; every other op uses the change routes. */
export const ENROLL_OP_TYPES: ReadonlySet<ChangeOpType> = new Set([
  'passkey.add', 'device.add', 'geolocation.add-zone', 'wifi.add-network', 'wifi.add-radio', 'wifi.add-bssid', 'bluetooth.add-device', 'mfa.add',
]);

/** A change with the values captured at finish (credential, device key, reading-derived zone, observed network, ...). */
export type AppliedChangeOp =
  | { type: 'passkey.add'; credential: PasskeyCredentialRecord }
  | { type: 'passkey.remove'; credentialId: string }
  | { type: 'device.add'; device: TrustedDeviceRecord }
  | { type: 'device.remove'; keyId: string }
  | { type: 'geolocation.add-zone'; zone: SafeZoneRecord }
  | { type: 'geolocation.remove-zone'; zoneId: string }
  | { type: 'wifi.add-network'; network: TrustedNetworkRecord }
  | { type: 'wifi.remove-network'; networkId: string }
  | { type: 'wifi.add-radio'; radio: WifiRadioRecord }
  | { type: 'wifi.add-bssid'; radioId: string; bssid: string }
  | { type: 'wifi.remove-radio'; radioId: string }
  | { type: 'wifi.set-mode'; mode: WifiMode }
  | { type: 'bluetooth.add-device'; device: BluetoothDeviceRecord }
  | { type: 'bluetooth.remove-device'; deviceId: string }
  | { type: 'limits.set'; perReleaseRaw: AssetCapRaw; perDayRaw: AssetCapRaw }
  | { type: 'mfa.add'; authenticator: TotpAuthenticatorRecord }
  | { type: 'layer.disable'; layer: DisableableLayerId };

export interface PendingChange {
  /** "chg_" + base64url(12 random bytes). */
  id: string;
  op: AppliedChangeOp;
  /**
   * New changes are pending only as recovery. 'loosen' is read from documents written before 2026-10-13, when
   * loosening waited 24 hours; such a change is now due at once (policy.ts effectiveConfig).
   */
  class: 'loosen' | 'recovery';
  /** [] for loosen. */
  waived: OptionalLayerId[];
  requestedAt: string;
  effectiveAt: string;
  /** The app the evidence came from; null when the change carried no evidence that identifies one (every enabled layer waived). */
  requestedFrom: Surface | null;
}
export interface ChangeHistoryEntry { id: string; summary: string; class: ChangeClass; outcome: 'applied' | 'cancelled'; at: string }

/** One vault's layer configuration, stored in the paired-vault store document (version 2). */
export interface VaultLayerConfig {
  /** >= 1; +1 on every write that changes the configuration (an applied, requested or cancelled change). */
  version: number;
  /** base64url, 32 random bytes; never the Privy id. */
  webauthnUserId: string;
  biometrics: { credentials: PasskeyCredentialRecord[] } | null;
  geolocation: { zones: SafeZoneRecord[] } | null;
  wifi: { mode: WifiMode; networks: TrustedNetworkRecord[]; radios: WifiRadioRecord[] } | null;
  bluetooth: { devices: BluetoothDeviceRecord[] } | null;
  /** The vault authenticator (MFA layer); null when MFA is off. Documents written before 2026-10-13 have no key, which reads as null. */
  mfa: TotpAuthenticatorRecord | null;
  /** null: Limits is off and no release cap applies (the default). */
  limits: VaultLimitsRecord | null;
  devices: TrustedDeviceRecord[];
  /** Ordered by effectiveAt. */
  pending: PendingChange[];
  /** The last applied or cancelled changes (summaries only, never readings). */
  history: ChangeHistoryEntry[];
  updatedAt: string;
}

/** Recorded on a ledger reservation whose layers passed. */
export interface LedgerLayerPass { challengeId: string; configVersion: number; passedAt: string; enforced: LayerId[] }

export interface BluetoothMatch { surface: Surface; source: BluetoothSource; identifier: string; name: string }
export type LayerRequirement =
  | { id: 'biometrics'; evidence: 'passkey' }
  | { id: 'geolocation'; evidence: 'device'; reading: 'geo' }
  | { id: 'wifi'; evidence: 'server' }
  | { id: 'wifi'; evidence: 'device'; reading: 'wifi'; desktopOnly: true }
  | { id: 'bluetooth'; evidence: 'device'; reading: 'bluetooth'; match: BluetoothMatch[] }
  /** A 6-digit code from the vault authenticator app, sent with this challenge's evidence. */
  | { id: 'mfa'; evidence: 'totp' }
  | { id: 'limits'; evidence: 'server' };

export type GeoSource = 'windows-location' | 'browser-geolocation';
export interface DeviceGeoReading { lat: number; lng: number; accuracyM: number; at: number; source: GeoSource }
export interface DeviceWifiReading { connections: Array<{ ssidHex: string; bssid: string }>; at: number; source: 'windows-wlan' }
export interface DeviceBluetoothReading { devices: Array<{ identifier: string; name: string }>; at: number; source: BluetoothSource }
export interface DevicePayloadV1 {
  v: 1;
  purpose: 'release' | 'change';
  challengeId: string;
  /** base64url 32 bytes, echoed from begin. */
  nonce: string;
  /** Lowercase hex 64, echoed from begin. */
  digest: string;
  keyId: string;
  surface: Surface;
  signedAt: number;
  geo?: DeviceGeoReading;
  wifi?: DeviceWifiReading;
  bluetooth?: DeviceBluetoothReading;
}
export interface DeviceEvidence { keyId: string; payload: string; signature: string }
/** The MFA layer's evidence: a code from the vault authenticator app. */
export interface TotpEvidence { code: string }
