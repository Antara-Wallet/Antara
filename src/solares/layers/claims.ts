/**
 * Honest claims for vault protection layers (docs/VAULT_LAYERS.md section 14).
 * The UI reads every badge and every "checked by" sentence from here, and shows a
 * layer's claims only while GET /solana/layers answered 200 and the layer is
 * enrolled. Nothing here says a layer is on.
 */
import type { LayerId, LayerKind, LayerView, Surface, WifiMode } from './types';

export const LAYER_NAMES: Record<LayerId, string> = {
  bluetooth: 'Bluetooth', wifi: 'Wi-Fi', biometrics: 'Biometrics', geolocation: 'Safe Zones', mfa: 'MFA', limits: 'Limits',
};

export const KIND_LABELS: Record<LayerKind, string> = {
  cryptographic: 'Cryptographic', 'device-reported': 'Device-reported', 'server-observed': 'Server-observed',
};
export const KIND_DESCRIPTIONS: Record<LayerKind, string> = {
  cryptographic: 'ANTARA verifies a signature, or the guardian enforces the rule itself.',
  'device-reported': 'Your trusted device reports this signal and signs it. ANTARA cannot verify the reading itself.',
  'server-observed': 'ANTARA’s server observes this directly.',
};

/**
 * The only kinds each layer may carry. A server answer with any other kind is refused,
 * so a badge can never overstate what a layer is.
 */
export function expectedKinds(id: LayerId, mode: WifiMode | null): LayerKind[] {
  switch (id) {
    case 'bluetooth': case 'geolocation': return ['device-reported'];
    case 'wifi': return mode === 'network+radio' ? ['server-observed', 'device-reported'] : ['server-observed'];
    default: return ['cryptographic'];
  }
}

/** Section 14.1, exact. */
export const CHECKED_BY = {
  all: "ANTARA's guardian votes only after every layer you turned on passes for this exact release. Layers are checked by ANTARA's server; a compromised ANTARA server could skip them.",
  biometrics: 'Your device verifies you (fingerprint, face or device PIN) and signs this exact release. ANTARA checks the signature. ANTARA never receives biometric data.',
  biometricsSynced: 'Synced passkey: any device signed in to your passkey provider can use it.',
  mfa: 'ANTARA checks a 6-digit code from your vault authenticator app with this exact release. Each code works once. The app’s secret is stored encrypted on ANTARA’s server, so a compromised ANTARA server could read it.',
  mfaSetup: 'Scan this code with an authenticator app such as Google Authenticator, or type the key. Then enter the 6-digit code it shows. ANTARA shows this key only now.',
  geolocation: 'Your trusted device reports where it is and signs the reading. ANTARA checks that it falls inside a safe zone. A modified device or location spoofing can fake this signal.',
  wifiNetwork: 'ANTARA checks the public internet address your request comes from. Anyone on the same network, or a VPN that exits there, shares that address.',
  wifiRadio: 'ANTARA Desktop reports the Wi-Fi name and access point it is connected to. Your device reports this; ANTARA cannot verify it.',
  bluetoothDesktop: 'ANTARA Desktop checks that your trusted Bluetooth device is connected to this computer. Distance is not measured.',
  bluetoothBrowser: 'You pick your trusted device from the Bluetooth devices Chrome finds nearby. Distance is not measured.',
  limits: 'ANTARA co-signs only single SOL or USDC releases to your own wallets, within the caps you set.',
  trustedDevices: "Readings are signed with a key created on this device. ANTARA cannot export it, but it is stored in this app's or browser's profile, not in secure hardware.",
  changes: 'Turning a layer on or tightening it takes effect immediately. Turning one off or loosening it also takes effect immediately, but needs every layer you have on. Recovery without a layer takes 7 days, and you can cancel it until then.',
  notifications: 'ANTARA does not send notifications about pending changes. Check this screen.',
  sessionRecovery: 'Someone holding your session can add a passkey through recovery; it takes effect after 7 days unless you cancel it, and can then be used to remove your original passkey.',
} as const;

/** The "checked by" lines for one layer the server reports as enrolled. Empty otherwise. */
export function checkedByLines(layer: Pick<LayerView, 'id' | 'status' | 'mode'>, surface: Surface): string[] {
  if (layer.status === 'not-enrolled') return [];
  switch (layer.id) {
    case 'biometrics': return [CHECKED_BY.biometrics];
    case 'mfa': return [CHECKED_BY.mfa];
    case 'geolocation': return [CHECKED_BY.geolocation];
    case 'wifi': return layer.mode === 'network+radio' ? [CHECKED_BY.wifiNetwork, CHECKED_BY.wifiRadio] : [CHECKED_BY.wifiNetwork];
    case 'bluetooth': return [surface === 'desktop' ? CHECKED_BY.bluetoothDesktop : CHECKED_BY.bluetoothBrowser];
    case 'limits': return [CHECKED_BY.limits];
  }
}

/** What turning a layer on would do. Shown only for a layer the server reports as not enrolled; never a claim that it is on. */
export const ENROLL_OFFERS: Record<LayerId, string> = {
  bluetooth: 'Not set up. Add a Bluetooth device you keep with you, and releases will need it.',
  wifi: 'Not set up. Trust the network you use, and releases will need to come from it.',
  biometrics: 'Required. Add a passkey (Windows Hello, Touch ID, Face ID, a phone or a security key) to finish activating this vault. Every release will need it.',
  geolocation: 'Not set up. Add a safe zone, and releases will need a signed location reading from inside it.',
  mfa: 'Off. Add ANTARA’s vault authenticator to an authenticator app, and every release will need a 6-digit code from it.',
  limits: 'Optional. Set your own caps per release or per day, and the guardian will refuse releases above them. ANTARA sets no cap of its own.',
};

/** Surface-specific limits the UI states next to a layer's actions. */
export const SURFACE_NOTES = {
  wifiRadioDesktopOnly: "This vault's Wi-Fi layer requires ANTARA Desktop.",
  wifiConsent: 'Allow location access for desktop apps in Windows Settings (Wi-Fi names are location data in Windows 11).',
  bluetoothDesktopClassic: 'ANTARA Desktop lists classic Bluetooth devices that are connected to this computer. Bluetooth Low Energy-only devices are not listed.',
  bluetoothPerSurface: 'Bluetooth devices are identified differently by ANTARA Desktop and by Chrome, so add your device in each app you approve from.',
  passkeyPhone: 'A passkey on your phone works from any of your devices through the “use a phone” option.',
  recovery: 'Waiving a layer you can no longer use turns this into a recovery change. It takes effect after 7 days, and you can cancel it until then.',
  fullTab: 'Chrome’s side panel cannot show passkey and Bluetooth prompts reliably yet, so this step continues in a full tab.',
  passkeyRequired: 'ANTARA requires a passkey for every vault. Until one is added, deposits and releases are paused here.',
  passkeyLast: 'A vault always needs a passkey. Add another one before removing this one.',
  passkeyFirst: 'Add a passkey to this vault first. Other protection changes open once it has one.',
  passkeyFirstPending: 'It was added outside the app and time that activated the vault, so it is a recovery change that waits 7 days. If you did not add it, cancel it under Pending changes in Vault settings.',
  passkeyFirstOtherApp: 'Add this vault’s first passkey from the app that activated it, within 15 minutes of activating. From anywhere else it takes effect after 7 days.',
  passkeyGooglePasswordManager: 'A passkey saved in Chrome’s Google Password Manager cannot be used by ANTARA Desktop. Use Windows Hello or your phone if you approve from both.',
} as const;

/** Honest claims for paired Solana vaults (docs/GUARDIAN.md, docs/SECURITY.md). Unchanged by layers. */
export const PAIRED_VAULT_CLAIMS = [
  'Vault releases need two signatures: your wallet and ANTARA’s guardian.',
  'On Solana the guardian can only vote. It cannot start or execute a transfer.',
  'ANTARA co-signs only single SOL or USDC releases to your own wallets linked to your account, within any caps you set.',
  'If ANTARA is unavailable, vault releases pause.',
  'If you lose access to your ANTARA login, vault funds cannot be released. There is no recovery owner in this version.',
  'Both keys are held by Privy: your wallet as a Privy embedded wallet, and the guardian as an ANTARA server wallet.',
  'Funds in your spending wallet are not protected by the vault.',
] as const;

/** Section 14.2 as patterns, for tests over every string this module exports. */
export const NEVER_CLAIM = [
  /fingerprint (?:or face )?(?:scan )?(?:is )?required|face scan is required/i,
  /per[- ]transaction MFA|fresh MFA|verified (?:your |a )?(?:MFA|code)/i,
  /verified location|GPS verified|cannot be spoofed|can't be spoofed/i,
  /Wi-?Fi verified/i,
  /\d+\s?m(?:etres|eters)? away|proximity verified/i,
  /hardware[- ]backed|\bTPM\b|secure enclave/i,
  /protect(?:s|ed)? against a compromised ANTARA server/i,
  /\bvoice\b|\bUSB\b/i,
];
