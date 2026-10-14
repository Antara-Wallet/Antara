/**
 * Approval and change flows for vault protection layers (docs/VAULT_LAYERS.md section 12).
 * Begin answers are checked before anything is asked of the user; evidence is collected
 * in a fixed order (Bluetooth first while the click still counts, the passkey last) and
 * nothing is sent unless every required reading and ceremony succeeded.
 */
import { PairedVaultApiError, requestGuardianApproval, type PairedApproval } from '../vaults/pairedApi';
import { beginChange, beginEnroll, beginLayerApproval, finishChange, finishEnroll } from './api';
import {
  collectBluetoothAddition, collectBluetoothChoice, collectBluetoothMatch, collectGeo, collectPasskey, collectWifi, createPasskey, LayerCollectionError, type LayerPlatform,
} from './collectors';
import { loadDeviceKey, signDevicePayload, type DeviceKey, type DeviceKeyStorage } from './deviceKey';
import { assertReleaseMatches, buildDevicePayload, webauthnChallenge } from './evidence';
import {
  isEnrollOp,
  type LayerId,
  type AuthenticationResponseJSON, type BluetoothReading, type ChangeChallenge, type ChangeOp, type ChangeResult, type GeoReading, type LayerChallenge, type OptionalLayerId, type PairedAssetName,
  type RegistrationResponseJSON, type ReleaseChallenge, type SignedDevicePayload, type WifiReading,
} from './types';
import { SURFACE_NOTES } from './claims';

export interface LayerContext {
  platform: LayerPlatform;
  keys: DeviceKeyStorage;
  privyUserId: string;
  multisig: string;
  /** Progress for the status line ("Checking Bluetooth"). */
  onStep?: (label: string) => void;
  /**
   * Structured progress for the verification planet (docs/UI_ARGUS_PARITY.md 8.7): called around each collector on this
   * device, in collection order (Bluetooth, geolocation, Wi-Fi radio, passkey). It never changes what is collected.
   */
  onLayer?: (id: LayerId, phase: 'collecting' | 'collected') => void;
  /**
   * The 6-digit code from the vault authenticator app, typed by the user for this challenge (MFA layer). Required when the
   * challenge asks for it ('totp') or when it adds the authenticator (capture.totp); checked before anything else is asked.
   */
  totpCode?: string | null;
}

/** Choices the user made before collection (enrollment only). */
export interface CollectionChoices {
  /** Desktop Bluetooth enrollment: the identifier picked from the connected devices. */
  bluetoothDevice?: string | null;
  /** Desktop Wi-Fi radio enrollment: `${ssidHex}/${bssid}` picked from the current connections. */
  wifiConnection?: string | null;
  /** device.add: the candidate key that signs its own proof of possession. */
  candidateKey?: DeviceKey | null;
  /**
   * Chrome, adding a Bluetooth device while Bluetooth is on: the trusted device found on an earlier click
   * (checkTrustedBluetooth). The new device is chosen on the Continue click; both go in one signed reading.
   */
  bluetoothMatched?: BluetoothReading | null;
}

export interface CollectedEvidence {
  passkey?: AuthenticationResponseJSON;
  registration?: RegistrationResponseJSON;
  device?: SignedDevicePayload;
  totp?: { code: string };
}

/** The vault authenticator's code format (RFC 6238, 6 digits). */
export const TOTP_CODE = /^\d{6}$/;
export const TOTP_CODE_MISSING = 'Enter the 6-digit code from your vault authenticator app.';
/** Whether this challenge needs a code from the vault authenticator (the MFA layer is on, or this adds it). */
export const needsTotpCode = (challenge: LayerChallenge) =>
  challenge.required.some(item => item.id === 'mfa' && item.evidence === 'totp') || (challenge.purpose === 'change' && challenge.capture.totp !== null);

const NOT_TRUSTED = 'This device isn’t trusted for this vault yet. Set it up with your passkey, then try again.';

/** The passkey challenges the server sent must be the ones derived from this nonce and digest (section 6.2). */
export async function assertChallengeBinding(challenge: LayerChallenge): Promise<void> {
  const get = challenge.purpose === 'release' ? challenge.webauthn : challenge.webauthn.get;
  const create = challenge.purpose === 'change' ? challenge.webauthn.create : null;
  if ((get && get.challenge !== await webauthnChallenge('get', challenge.nonce, challenge.digest)) ||
    (create && create.challenge !== await webauthnChallenge('create', challenge.nonce, challenge.digest))) {
    throw new Error('The vault service sent a verification request that does not match this action. Nothing was approved.');
  }
}

/** What this challenge needs this device to read. */
export function readingsFor(challenge: LayerChallenge) {
  const required = (reading: 'geo' | 'wifi' | 'bluetooth') => challenge.required.some(item => item.evidence === 'device' && item.reading === reading);
  const capture = challenge.purpose === 'change' ? challenge.capture : { geo: false, wifi: false, bluetooth: false, network: null };
  const bluetoothRequirement = challenge.required.find(item => item.reading === 'bluetooth') ?? null;
  return {
    geo: required('geo') || capture.geo,
    wifi: required('wifi') || capture.wifi,
    // A release or loosening proves an enrolled device ('match'); turning Bluetooth on captures exactly one chosen
    // device ('choose'); adding a device while Bluetooth is on does both in one reading ('add', section 8.1).
    bluetooth: capture.bluetooth ? bluetoothRequirement ? 'add' as const : 'choose' as const : bluetoothRequirement ? 'match' as const : null,
    match: bluetoothRequirement?.match ?? [],
    passkey: challenge.purpose === 'release' ? challenge.webauthn : challenge.webauthn.get,
    registration: challenge.purpose === 'change' ? challenge.webauthn.create : null,
  };
}

/** The trusted device key that will sign this challenge's readings. Checked before any prompt, so nothing is asked that could not be signed. */
async function signingKey(challenge: LayerChallenge, context: LayerContext, choices: CollectionChoices): Promise<DeviceKey> {
  const surface = context.platform.capabilities().surface;
  const isDeviceAdd = choices.candidateKey != null;
  const key = isDeviceAdd ? choices.candidateKey! : await loadDeviceKey(context.keys, context.privyUserId, context.multisig);
  if (!key) throw new LayerCollectionError('device', NOT_TRUSTED, 'add-device');
  if (key.surface !== surface) throw new LayerCollectionError('device', NOT_TRUSTED, 'add-device');
  if (!isDeviceAdd && !challenge.devices.some(device => device.keyId === key.keyId && device.surface === key.surface)) throw new LayerCollectionError('device', NOT_TRUSTED, 'add-device');
  return key;
}

/** Chrome needs a separate click to find the trusted device before choosing a new one ('add' on Web Bluetooth). */
export function needsTrustedBluetoothFirst(challenge: LayerChallenge, platform: Pick<LayerPlatform, 'capabilities'>): boolean {
  return readingsFor(challenge).bluetooth === 'add' && platform.capabilities().bluetooth === 'web-bluetooth';
}

/**
 * First click of a Bluetooth addition in Chrome: finds a trusted device with the chooser filtered to it.
 * Nothing is signed or sent; collectEvidence adds the new device on the next click and signs both together.
 */
export async function checkTrustedBluetooth(challenge: ChangeChallenge, context: LayerContext): Promise<BluetoothReading> {
  const capabilities = context.platform.capabilities();
  if (!needsTrustedBluetoothFirst(challenge, context.platform)) throw new Error('This change does not need a separate Bluetooth check.');
  if (!capabilities.ceremonyInline) throw new LayerCollectionError('device', SURFACE_NOTES.fullTab, 'open-full-tab');
  await signingKey(challenge, context, {});
  context.onStep?.('Checking your Bluetooth device');
  return collectBluetoothMatch(context.platform, readingsFor(challenge).match, challenge.nonce);
}

/** Collects every reading and ceremony the challenge needs, in order, then signs the device payload. Throws before sending anything. */
export async function collectEvidence(challenge: LayerChallenge, context: LayerContext, choices: CollectionChoices = {}): Promise<CollectedEvidence> {
  const { platform } = context;
  const capabilities = platform.capabilities();
  const needs = readingsFor(challenge);
  if (challenge.required.some(item => item.desktopOnly) && capabilities.surface !== 'desktop') throw new LayerCollectionError('wifi', SURFACE_NOTES.wifiRadioDesktopOnly);
  // The code is typed before anything is collected, so no prompt is shown for evidence that could not be sent.
  const totpCode = needsTotpCode(challenge) ? (context.totpCode ?? '').trim() : null;
  if (totpCode !== null && !TOTP_CODE.test(totpCode)) throw new LayerCollectionError('mfa', TOTP_CODE_MISSING, null, challenge.purpose === 'change' && challenge.capture.totp !== null);
  const isDeviceAdd = choices.candidateKey != null;
  const anyReading = needs.geo || needs.wifi || needs.bluetooth !== null;
  // Expiry is the server's to judge (clocks differ); an expired challenge is refused there and the UI starts again.
  if ((anyReading || isDeviceAdd || needs.passkey || needs.registration) && !capabilities.ceremonyInline) throw new LayerCollectionError('device', SURFACE_NOTES.fullTab, 'open-full-tab');

  // The signing key is checked first, so no prompt is shown for readings that could not be signed.
  const key: DeviceKey | null = anyReading || isDeviceAdd ? await signingKey(challenge, context, choices) : null;

  let bluetooth: BluetoothReading | undefined, geo: GeoReading | undefined, wifi: WifiReading | undefined;
  if (needs.bluetooth !== null) context.onLayer?.('bluetooth', 'collecting');
  if (needs.bluetooth === 'match') { context.onStep?.('Checking your Bluetooth device'); bluetooth = await collectBluetoothMatch(platform, needs.match, challenge.nonce); }
  if (needs.bluetooth === 'choose') { context.onStep?.('Reading your Bluetooth device'); bluetooth = await collectBluetoothChoice(platform, choices.bluetoothDevice ?? null); }
  if (needs.bluetooth === 'add') {
    context.onStep?.('Reading your Bluetooth devices');
    bluetooth = await collectBluetoothAddition(platform, needs.match, challenge.nonce, choices.bluetoothDevice ?? null, choices.bluetoothMatched ?? null);
  }
  if (needs.bluetooth !== null) context.onLayer?.('bluetooth', 'collected');
  if (needs.geo) { context.onLayer?.('geolocation', 'collecting'); context.onStep?.('Reading your location'); geo = await collectGeo(platform); context.onLayer?.('geolocation', 'collected'); }
  if (needs.wifi) {
    context.onLayer?.('wifi', 'collecting');
    context.onStep?.('Reading your Wi-Fi connection');
    const current = await collectWifi(platform);
    const captureOne = challenge.purpose === 'change' && challenge.capture.wifi && choices.wifiConnection !== undefined;
    if (captureOne) {
      const picked = current.connections.filter(item => `${item.ssidHex}/${item.bssid}` === choices.wifiConnection);
      if (picked.length !== 1) throw new LayerCollectionError('wifi', 'Choose the Wi-Fi network this computer is connected to.', null, true);
      wifi = { connections: picked, at: current.at, source: current.source };
    } else wifi = { connections: current.connections, at: current.at, source: current.source };
    context.onLayer?.('wifi', 'collected');
  }

  const evidence: CollectedEvidence = {};
  if (key) {
    const payload = buildDevicePayload({
      purpose: challenge.purpose, challengeId: challenge.challengeId, nonce: challenge.nonce, digest: challenge.digest,
      keyId: key.keyId, surface: key.surface, signedAt: platform.now(), geo, wifi, bluetooth,
    });
    evidence.device = await signDevicePayload(key, payload);
  }
  if (needs.passkey) {
    context.onLayer?.('biometrics', 'collecting');
    context.onStep?.('Waiting for your passkey');
    evidence.passkey = await collectPasskey(platform, needs.passkey);
    context.onLayer?.('biometrics', 'collected');
  }
  if (needs.registration) { context.onStep?.('Creating your passkey'); evidence.registration = await createPasskey(platform, needs.registration); }
  if (totpCode !== null) evidence.totp = { code: totpCode };
  return evidence;
}

// ---- Release approval --------------------------------------------------------------------------

export interface ReleaseOnDevice { asset: PairedAssetName; amountRaw: string; recipient: string }

/**
 * Section 12 step 3: begin, then read the proposal from Solana on this device and refuse unless the
 * server describes exactly that release. Nothing is asked of the user before this passes.
 */
export async function beginReleaseLayers(token: string, multisig: string, transactionIndex: string, readOnDevice: () => Promise<ReleaseOnDevice>): Promise<ReleaseChallenge> {
  const challenge = await beginLayerApproval(token, multisig, transactionIndex);
  const onDevice = await readOnDevice();
  assertReleaseMatches(challenge.release, { multisig, transactionIndex, asset: onDevice.asset, amountRaw: onDevice.amountRaw, recipient: onDevice.recipient });
  await assertChallengeBinding(challenge);
  return challenge;
}

export type ReleaseApprovalStart =
  | { kind: 'approved'; approval: PairedApproval }
  /** Extension side panel: the ceremonies continue in the full tab (section 12 step 2). */
  | { kind: 'full-tab' }
  | { kind: 'verify'; challenge: ReleaseChallenge };

/**
 * Section 12 steps 1 to 3. Asks the guardian without evidence first: a vault without layers (or a
 * reservation whose layers passed recently) is approved as before. Only '403 layers-required' leads
 * to the layer step; every other refusal is thrown unchanged.
 */
export async function startReleaseApproval(
  getToken: () => Promise<string>, multisig: string, transactionIndex: string, readOnDevice: () => Promise<ReleaseOnDevice>, platform: Pick<LayerPlatform, 'capabilities'>,
): Promise<ReleaseApprovalStart> {
  try { return { kind: 'approved', approval: await requestGuardianApproval(await getToken(), multisig, transactionIndex) }; }
  catch (failure) { if (!(failure instanceof PairedVaultApiError) || failure.code !== 'layers-required') throw failure; }
  if (!platform.capabilities().ceremonyInline) return { kind: 'full-tab' };
  return { kind: 'verify', challenge: await beginReleaseLayers(await getToken(), multisig, transactionIndex, readOnDevice) };
}

/** Sections 12 steps 5 to 7: collect, sign, then ask the guardian to vote with the evidence. */
export async function submitReleaseApproval(getToken: () => Promise<string>, challenge: ReleaseChallenge, context: LayerContext): Promise<PairedApproval> {
  const evidence = await collectEvidence(challenge, context);
  context.onStep?.('Requesting ANTARA’s approval');
  return requestGuardianApproval(await getToken(), context.multisig, challenge.release.transactionIndex, {
    challengeId: challenge.challengeId, ...(evidence.passkey ? { passkey: evidence.passkey } : {}), ...(evidence.device ? { device: evidence.device } : {}),
    ...(evidence.totp ? { totp: evidence.totp } : {}),
  });
}

// ---- Enrollment and changes --------------------------------------------------------------------

export async function beginLayerChange(token: string, multisig: string, op: ChangeOp, waive: OptionalLayerId[] = []): Promise<ChangeChallenge> {
  const challenge = isEnrollOp(op) ? await beginEnroll(token, multisig, op, waive) : await beginChange(token, multisig, op, waive);
  if (op.type === 'passkey.add' && !challenge.webauthn.create) throw new Error('The vault service did not start a passkey registration. Nothing was changed.');
  if (op.type !== 'passkey.add' && challenge.webauthn.create) throw new Error('The vault service sent an unexpected passkey registration. Nothing was changed.');
  await assertChallengeBinding(challenge);
  return challenge;
}

export async function finishLayerChange(getToken: () => Promise<string>, op: ChangeOp, challenge: ChangeChallenge, context: LayerContext, choices: CollectionChoices = {}): Promise<ChangeResult> {
  if (op.type === 'device.add') {
    if (!choices.candidateKey || choices.candidateKey.publicKeySpki !== op.publicKeySpki) throw new LayerCollectionError('device', 'This device’s key changed. Start again.');
  } else if (choices.candidateKey) throw new Error('Only adding a device uses a new device key.');
  const evidence = await collectEvidence(challenge, context, choices);
  context.onStep?.('Saving your change');
  const token = await getToken();
  return isEnrollOp(op) ? finishEnroll(token, context.multisig, challenge.challengeId, evidence) : finishChange(token, context.multisig, challenge.challengeId, evidence);
}
