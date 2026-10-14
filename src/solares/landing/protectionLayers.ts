import type { LayerId } from '../layers/types';

/**
 * The six vault layers, in the order the landing presents them. Descriptions explain how each layer is designed
 * to work without claiming it is active for the visitor. `signal` says honestly who supplies the evidence:
 * cryptographic and server-enforced checks are distinguished from readings a device reports. Status strings are
 * docs/VAULT_LAYERS.md section 14.3: the layers are implemented for paired Solana vaults, and stay "not live yet"
 * until the owner switch and funded and hardware acceptance are recorded in docs/VERIFICATION.md.
 */
export type ProtectionLayer = {
  readonly id: LayerId;
  readonly name: string;
  readonly short: string;
  readonly index: string;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly checks: string;
  readonly signal: string;
  readonly mode: 'Required' | 'Optional';
  readonly status: string;
};

export const protectionLayers: readonly ProtectionLayer[] = [
  {
    id: 'biometrics', name: 'Biometrics', short: 'Biometrics', index: '01', label: 'PERSONAL VERIFICATION',
    title: 'An approval only you can make.',
    description: 'A passkey on your device, unlocked with a fingerprint, face or device PIN, approves each vault release. ANTARA verifies the passkey signature before the guardian adds its signature.',
    checks: 'A passkey signature for this release',
    signal: 'Cryptographic · passkey signature',
    mode: 'Required',
    status: 'Paired-vault layer · passkey verified by ANTARA · not live yet',
  },
  {
    id: 'mfa', name: 'MFA', short: 'MFA', index: '02', label: 'EXTRA VERIFICATION',
    title: 'One more code. For the vault alone.',
    description: 'An authenticator app for your vault only. While it is on, every vault release needs a fresh 6-digit code that ANTARA checks for that release, and each code works once. Your regular wallet never asks for one.',
    checks: 'A one-time 6-digit authenticator code',
    signal: 'Server-enforced · code checked by ANTARA',
    mode: 'Optional',
    status: 'Paired-vault layer · optional vault authenticator code · not live yet',
  },
  {
    id: 'geolocation', name: 'Safe Zones', short: 'Safe Zones', index: '03', label: 'LOCATION CHECK',
    title: 'Define where a release belongs.',
    description: 'Name the places where you approve releases. When you approve, your device reports its location and the guardian compares it with your safe zones. The reading comes from your device, so it adds context rather than proof.',
    checks: 'Your reported location against your safe zones',
    signal: 'Device-reported · location from your device',
    mode: 'Optional',
    status: 'Paired-vault layer · device-reported · not live yet',
  },
  {
    id: 'wifi', name: 'Wi-Fi', short: 'Wi-Fi', index: '04', label: 'TRUSTED NETWORK',
    title: 'A familiar network. Another signal.',
    description: 'Approve from a network you trust. ANTARA compares the public network a release request arrives from, and ANTARA Desktop can also match the Wi-Fi name. A network alone never establishes ownership.',
    checks: 'The network a release request comes from',
    signal: 'Server-observed network · Wi-Fi name on Desktop',
    mode: 'Optional',
    status: 'Paired-vault layer · public network check, Wi-Fi name on Desktop · not live yet',
  },
  {
    id: 'bluetooth', name: 'Bluetooth', short: 'Bluetooth', index: '05', label: 'DEVICE PRESENCE',
    title: 'Keep a trusted device close.',
    description: 'Register a Bluetooth device you keep with you. When you approve, ANTARA Desktop reports it connected, or Chrome lets you pick it from nearby devices. It is a presence signal; distance is not measured.',
    checks: 'A registered Bluetooth device you keep with you',
    signal: 'Device-reported · presence from your device',
    mode: 'Optional',
    status: 'Paired-vault layer · device-reported · not live yet',
  },
  {
    id: 'limits', name: 'Limits', short: 'Limits', index: '06', label: 'SPENDING BOUNDARIES',
    title: 'Your caps, if you want them.',
    description: 'Optional caps you set yourself, for each release, for each day, or both. ANTARA sets no cap of its own. While Limits is on, the guardian checks the amount before it signs and refuses a release above your caps.',
    checks: 'The amount against the caps you set',
    signal: 'Server-enforced · checked by the guardian',
    mode: 'Optional',
    status: 'Paired-vault layer · optional caps you set, enforced by the guardian · not live yet',
  },
];
