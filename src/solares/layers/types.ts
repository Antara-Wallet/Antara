/**
 * Client mirror of the vault protection layer contract (docs/VAULT_LAYERS.md
 * sections 5, 6 and 9). Client and server share no module: each side implements
 * the contract and its tests pin the JSON examples from the spec.
 */
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON };

/** Landing order. GET /solana/layers always answers all six, in this order. */
export const LAYER_IDS = ['bluetooth', 'wifi', 'biometrics', 'geolocation', 'mfa', 'limits'] as const;
export type LayerId = typeof LAYER_IDS[number];
/**
 * Evidence-bearing layers a user can enroll, turn off or waive. MFA is ANTARA's own vault
 * authenticator (owner decision 2026-10-13: no MFA on the regular wallet), optional like the others.
 * Limits is optional too and off by default (owner decision 2026-10-13): it is set with limits.set or
 * turned off with layer.disable, and is never waived because it needs no evidence.
 */
export const OPTIONAL_LAYER_IDS = ['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa'] as const;
export type OptionalLayerId = typeof OPTIONAL_LAYER_IDS[number];
export const SURFACES = ['desktop', 'extension', 'web'] as const;
export type Surface = typeof SURFACES[number];
export const LAYER_KINDS = ['cryptographic', 'device-reported', 'server-observed'] as const;
export type LayerKind = typeof LAYER_KINDS[number];
export type LayerStatus = 'enrolled' | 'not-enrolled' | 'pending-removal';
export type ItemState = 'active' | 'pending-addition' | 'pending-removal';
/** tighten and loosen apply at once (loosen needs every layer that is on); only recovery waits (7 days). */
export type ChangeClass = 'tighten' | 'loosen' | 'recovery';
/** Layers layer.disable accepts: the evidence-bearing optional layers and Limits. */
export type DisableableLayerId = OptionalLayerId | 'limits';
export type WifiMode = 'network' | 'network+radio';
export type PairedAssetName = 'SOL' | 'USDC';
export type PerAssetRaw = { SOL: bigint; USDC: bigint };
/** One optional cap per asset (raw units); null means no cap. */
export type PerAssetCap = { SOL: bigint | null; USDC: bigint | null };

export const isOptionalLayer = (id: string): id is OptionalLayerId => (OPTIONAL_LAYER_IDS as readonly string[]).includes(id);

// ---- GET /solana/layers (section 9.1) -------------------------------------------------------

export interface LayerItem {
  id: string;
  type: string;
  label: string;
  detail: string;
  state: ItemState;
  since: number | null;
  effectiveAt: number | null;
  changeId: string | null;
}
/** The caps the user set through the Limits layer; every value null while Limits is off. There is no server cap, ceiling or minimum. */
export interface LayerLimitsView {
  perRelease: PerAssetCap;
  perDay: PerAssetCap;
}
export interface LayerView {
  id: LayerId;
  kinds: LayerKind[];
  status: LayerStatus;
  enforced: boolean;
  items: LayerItem[];
  /** Wi-Fi only, when enrolled. */
  mode: WifiMode | null;
  /** Set when status is pending-removal: the change that would turn the layer off. */
  changeId: string | null;
  effectiveAt: number | null;
  /** Limits only. */
  limits: LayerLimitsView | null;
}
export interface TrustedDeviceView {
  keyId: string;
  label: string;
  surface: Surface;
  state: ItemState;
  since: number | null;
  effectiveAt: number | null;
  changeId: string | null;
}
/**
 * The least the wallet needs to warn about a pending change and offer Cancel. Kept even when the
 * rest of GET /solana/layers cannot be shown (`waived` is null when it could not be read).
 */
export interface PendingChangeNotice {
  id: string;
  class: 'loosen' | 'recovery';
  effectiveAt: number;
  waived: OptionalLayerId[] | null;
}
export interface PendingChangeView extends PendingChangeNotice {
  /** ANTARA's text. It may quote a label the user (or whoever holds the session) chose, so it is shown as text only, never as a claim. */
  summary: string;
  /** User-chosen label, when the server returns it apart from the summary. */
  label: string | null;
  requestedAt: number;
  waived: OptionalLayerId[];
}
export interface VaultLayersView {
  multisig: string;
  configVersion: number;
  serverTime: number;
  network: { observed: boolean; trusted: boolean | null };
  layers: LayerView[];
  devices: TrustedDeviceView[];
  pending: PendingChangeView[];
}

// ---- Requirements and challenges (sections 9.2 and 9.4) -------------------------------------

export type DeviceReadingName = 'geo' | 'bluetooth' | 'wifi';
export type BluetoothSource = 'windows-classic' | 'web-bluetooth';
export interface BluetoothMatch { surface: Surface; source: BluetoothSource; identifier: string; name: string }
export interface LayerRequirement {
  id: LayerId;
  /** 'totp': a 6-digit code from the vault authenticator app, typed by the user and sent with the evidence. */
  evidence: 'passkey' | 'device' | 'server' | 'totp';
  reading: DeviceReadingName | null;
  /** Bluetooth only: every enrolled device. The client filters it to its own surface. */
  match: BluetoothMatch[];
  /** Wi-Fi radio only. */
  desktopOnly: boolean;
}
export interface ReleaseSummary { multisig: string; transactionIndex: string; asset: PairedAssetName; amountRaw: string; recipient: string }
interface ChallengeBase {
  challengeId: string;
  expiresAt: number;
  /** base64url, 32 bytes. */
  nonce: string;
  /** Lowercase hex, 32 bytes. */
  digest: string;
  configVersion: number;
  required: LayerRequirement[];
  /** Active trusted devices. */
  devices: { keyId: string; surface: Surface }[];
}
export interface ReleaseChallenge extends ChallengeBase {
  purpose: 'release';
  release: ReleaseSummary;
  webauthn: PublicKeyCredentialRequestOptionsJSON | null;
}
export interface ChangeCapture {
  geo: boolean;
  wifi: boolean;
  bluetooth: boolean;
  network: { observedCidr: string } | null;
  /** mfa.add: the new authenticator's base32 secret, shown once as a QR code and a manual key. */
  totp: { secret: string } | null;
}
export interface ChangeChallenge extends ChallengeBase {
  purpose: 'change';
  class: ChangeClass;
  /** Null when the change applies immediately. */
  effectiveAt: number | null;
  webauthn: { get: PublicKeyCredentialRequestOptionsJSON | null; create: PublicKeyCredentialCreationOptionsJSON | null };
  capture: ChangeCapture;
}
export type LayerChallenge = ReleaseChallenge | ChangeChallenge;

export type ChangeResult =
  | { status: 'applied'; configVersion: number }
  | { status: 'pending'; change: { id: string; class: 'loosen' | 'recovery'; effectiveAt: number } };
export interface CancelResult { status: 'cancelled'; configVersion: number }

/** One entry of a 403 layer-failed answer. */
export interface LayerResult { id: LayerId; ok: boolean; reason: string | null }

// ---- Change operations (section 8.1) ---------------------------------------------------------

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
  | { type: 'limits.set'; perReleaseRaw: { SOL: string | null; USDC: string | null }; perDayRaw: { SOL: string | null; USDC: string | null } }
  | { type: 'mfa.add'; label: string }
  | { type: 'layer.disable'; layer: DisableableLayerId };

const ENROLL_SUFFIXES = ['.add', '.add-zone', '.add-network', '.add-radio', '.add-bssid', '.add-device'];
/** Additions go through /layers/enroll/*, every other change through /layers/change/* (section 9.4). */
export const isEnrollOp = (op: ChangeOp) => ENROLL_SUFFIXES.some(suffix => op.type.endsWith(suffix));

// ---- Evidence (section 6) --------------------------------------------------------------------

export type GeoSource = 'windows-location' | 'browser-geolocation';
export interface GeoReading { lat: number; lng: number; accuracyM: number; at: number; source: GeoSource }
export interface WifiConnectionReading { ssidHex: string; bssid: string }
export interface WifiReading { connections: WifiConnectionReading[]; at: number; source: 'windows-wlan' }
export interface BluetoothDeviceReading { identifier: string; name: string }
export interface BluetoothReading { devices: BluetoothDeviceReading[]; at: number; source: BluetoothSource }
/** The server parses at most this many Bluetooth devices in one reading. */
export const MAX_BLUETOOTH_DEVICES = 8;
export interface DevicePayloadV1 {
  v: 1;
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
export interface SignedDevicePayload { keyId: string; payload: string; signature: string }
export interface LayerEvidence {
  challengeId: string;
  passkey?: AuthenticationResponseJSON;
  device?: SignedDevicePayload;
  /** The MFA layer: a code from the vault authenticator app. */
  totp?: { code: string };
}
/** Readings a surface may send, by key surface (section 6.3). */
export const READING_SOURCES: Record<Surface, { geo: GeoSource; bluetooth: BluetoothSource; wifi: 'windows-wlan' | null }> = {
  desktop: { geo: 'windows-location', bluetooth: 'windows-classic', wifi: 'windows-wlan' },
  extension: { geo: 'browser-geolocation', bluetooth: 'web-bluetooth', wifi: null },
  web: { geo: 'browser-geolocation', bluetooth: 'web-bluetooth', wifi: null },
};
export const MAX_DEVICE_PAYLOAD_BYTES = 4096;
export const MAX_EVIDENCE_BYTES = 16 * 1024;

// ---- Platform (section 11, implemented in src/platform/layers.ts) ----------------------------

export interface LayerCapabilities {
  surface: Surface;
  passkey: 'native' | 'browser' | 'none';
  geolocation: 'native' | 'browser' | 'none';
  bluetooth: 'native' | 'web-bluetooth' | 'none';
  wifiRadio: boolean;
  ceremonyInline: boolean;
}
