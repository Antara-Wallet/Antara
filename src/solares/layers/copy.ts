/**
 * Plain words for the protection list and its sheets (owner feedback 2026-10-13: simple, short, human).
 * No internal terms (enrolled, op, surface, ledger), never a dash placeholder, and nothing here says a layer
 * is on: the sheets show these only next to the server's own answer. The exact honesty claims stay in
 * claims.ts and appear under "How ANTARA checks this".
 */
import type { LayerId, Surface } from './types';

export type LayerFormKind = 'passkey.add' | 'device.add' | 'geolocation.add-zone' | 'wifi.add-network' | 'wifi.add-radio' | 'bluetooth.add-device' | 'limits.set' | 'mfa.add';

/** The form that turns each layer on. */
export const SETUP_FORM: Readonly<Record<LayerId, LayerFormKind>> = Object.freeze({
  biometrics: 'passkey.add', geolocation: 'geolocation.add-zone', wifi: 'wifi.add-network', bluetooth: 'bluetooth.add-device', mfa: 'mfa.add', limits: 'limits.set',
});
/** The layer (or the devices list) a form belongs to. */
export const FORM_LAYER: Readonly<Record<LayerFormKind, LayerId | 'devices'>> = Object.freeze({
  'passkey.add': 'biometrics', 'device.add': 'devices', 'geolocation.add-zone': 'geolocation', 'wifi.add-network': 'wifi', 'wifi.add-radio': 'wifi',
  'bluetooth.add-device': 'bluetooth', 'limits.set': 'limits', 'mfa.add': 'mfa',
});

/** Sheet title and button for a form: turning the layer on, or adding to a layer that is on. */
export function formTitle(kind: LayerFormKind, layerOn: boolean): string {
  switch (kind) {
    case 'passkey.add': return layerOn ? 'Add another passkey' : 'Add a passkey';
    case 'device.add': return 'Set up this device';
    case 'geolocation.add-zone': return layerOn ? 'Add a safe zone' : 'Turn on Safe Zones';
    // "Turn on Wi-Fi" read like switching the computer's Wi-Fi on (UX review 2026-10-13).
    case 'wifi.add-network': return layerOn ? 'Trust another network' : 'Use only this network';
    case 'wifi.add-radio': return 'Also check the Wi-Fi name';
    case 'bluetooth.add-device': return layerOn ? 'Add a Bluetooth device' : 'Turn on Bluetooth';
    case 'limits.set': return layerOn ? 'Change your limits' : 'Turn on Limits';
    case 'mfa.add': return 'Turn on MFA';
  }
}

/** The step that trusts this device for the vault, named for what the user is on (UX review 2026-10-13: "trust" read like an error). */
export const setupTitle = (surface: Surface) => surface === 'desktop' ? 'Set up this computer' : 'Set up this browser';

/**
 * One sentence at the top of a form: what the change does. Section 14.2 holds here too: Safe Zones and Bluetooth are
 * reported by the user's device (no geofence or proximity guarantee), and Wi-Fi on the web is the public internet address.
 */
export const FORM_LEAD: Readonly<Record<LayerFormKind, string>> = Object.freeze({
  'passkey.add': 'Your fingerprint, face or PIN will approve every release. ANTARA never receives biometric data.',
  'device.add': 'Lets this device report your location, Wi-Fi name and Bluetooth for this vault.',
  'geolocation.add-zone': 'Releases will need your device to report a location inside this place.',
  'wifi.add-network': 'Releases will need to come from the internet address you’re on now.',
  'wifi.add-radio': 'Releases from this computer will also need it to report this Wi-Fi name.',
  'bluetooth.add-device': 'Releases will need this Bluetooth device. Distance isn’t measured.',
  'limits.set': 'Releases above your limits are refused. Leave a field empty for no limit.',
  'mfa.add': 'Every release will also need a 6-digit code from your authenticator app.',
});

/** Default names, so most forms need no typing. */
export function defaultName(kind: LayerFormKind, surface: Surface): string {
  switch (kind) {
    case 'passkey.add': return surface === 'desktop' ? 'Windows Hello' : 'Passkey';
    case 'device.add': return DEVICE_NAMES[surface];
    case 'geolocation.add-zone': return 'Home';
    case 'wifi.add-network': return 'Home';
    case 'wifi.add-radio': return 'Home Wi-Fi';
    case 'bluetooth.add-device': return 'My phone';
    case 'mfa.add': return 'Authenticator app';
    case 'limits.set': return '';
  }
}
/** The name a trusted device gets, and how the devices list names each app. */
export const DEVICE_NAMES: Readonly<Record<Surface, string>> = Object.freeze({ desktop: 'ANTARA Desktop', extension: 'Chrome extension', web: 'Web browser' });

/** One sentence at the top of a layer's Manage sheet. */
export const MANAGE_LEAD: Readonly<Record<LayerId, string>> = Object.freeze({
  biometrics: 'Every release needs one of these passkeys.',
  geolocation: 'Releases need your device to report a location inside one of these places.',
  wifi: 'Releases need to come from the internet address of one of these networks.',
  bluetooth: 'Releases need one of these devices. Distance isn’t measured.',
  mfa: 'Releases need a code from this authenticator app.',
  limits: 'Releases above your limits are refused. Leave a field empty for no limit.',
});

/** What turning a layer off means, for its confirmation. */
export const TURN_OFF_LINE: Readonly<Record<Exclude<LayerId, 'biometrics'>, string>> = Object.freeze({
  geolocation: 'Releases will no longer need a safe zone.',
  wifi: 'Releases will no longer need a trusted network.',
  bluetooth: 'Releases will no longer need your Bluetooth device.',
  mfa: 'Releases will no longer need an authenticator code.',
  limits: 'Your limits will no longer apply.',
});

/** The headline once a change is done. */
export function doneTitle(kind: 'on' | 'added' | 'off' | 'removed' | 'saved' | 'trusted', name: string): string {
  switch (kind) {
    case 'on': return `${name} is on`;
    case 'added': return `${name} added`;
    case 'off': return `${name} is off`;
    case 'removed': return `${name} removed`;
    case 'saved': return 'Saved';
    case 'trusted': return 'This device is set up';
  }
}

/** How each kind of check works, in a few plain words (the exact claims follow it under "How ANTARA checks this"). */
export const KIND_SHORT: Readonly<Record<'cryptographic' | 'device-reported' | 'server-observed', string>> = Object.freeze({
  cryptographic: 'Checked with a signature.',
  'device-reported': 'Reported and signed by your trusted device.',
  'server-observed': 'Seen by ANTARA’s server.',
});

export const SHEET_COPY = Object.freeze({
  more: 'More options',
  how: 'How ANTARA checks this',
  onceOn: 'Once it’s on:',
  howAll: 'How protection works',
  nextSteps: 'What happens next',
  oneStep: 'You’ll confirm with your passkey.',
  working: 'Checking what this needs',
  retry: 'Try again',
  close: 'Done',
  stuck: 'That didn’t finish',
  setUpFirst: 'One step first',
  nothingChanged: 'Nothing was changed.',
  recoveryAsk: 'Can’t use one of these layers?',
  fullTab: 'Changes to protection continue in a full tab.',
  openFullTab: 'Open in a full tab',
  lastPasskey: 'A vault always needs a passkey. Add another one before removing this one.',
  devicesTitle: 'Your devices',
  devicesLead: 'These can report your location, Wi-Fi name and Bluetooth.',
  pendingTitle: 'Pending changes',
  confirmNote: 'You’ll confirm with your passkey. Loosening checks every layer you have on.',
  trustedAfterPasskey: 'This device is set up too, so layers that read from it only need your passkey.',
  trustLater: 'This device will be set up when you turn on a layer that needs it.',
  needCode: 'Enter the 6-digit code from the app.',
  needBluetooth: 'Connect the Bluetooth device to this computer first.',
  needWifi: 'Choose the Wi-Fi network first.',
});
