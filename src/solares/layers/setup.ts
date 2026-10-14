/**
 * One protection change from one click (owner feedback 2026-10-13: "why doesn't it just take the location of the
 * browser?"). Setting this device up is part of the flow, never a separate error: when the change itself reads from
 * this device (a safe zone, a Bluetooth device, a Wi-Fi name; its form lists the step before anything starts) and this
 * device is not trusted for the vault yet, the flow trusts it first (device.add with this device's own key) and then
 * makes the change. Any other change that would need a reading from an untrusted device stops before any prompt and
 * offers "Set up this browser" as the user's own choice (security review 2026-10-13).
 *
 * Nothing is weakened or skipped:
 * - each change is its own server challenge, single use and bound to that one change, with its own passkey
 *   assertion (a challenge for the second change cannot be issued before the first is applied: it would be stale);
 * - the server still decides each change's class and requirements, and every refusal stops the flow;
 * - the flow waits for the user whenever only they can give something: a 6-digit code, a choice, the click Chrome's
 *   Bluetooth chooser needs, or consent to a 7-day recovery.
 * No React here, so the chain is tested end to end against the real server routes (setupFlow.test.ts).
 */
import { friendlyError } from '../ui/friendlyError';
import { PairedVaultApiError } from '../vaults/pairedApi';
import { setupTitle } from './copy';
import { collectWifi, connectedBluetoothDevices, LayerCollectionError, trustedDesktopDevices, type CollectionAction, type LayerPlatform } from './collectors';
import { ensureDeviceKey, loadDeviceKey, type DeviceKey } from './deviceKey';
import { TOTP_CODE, beginLayerChange, finishLayerChange, needsTotpCode, needsTrustedBluetoothFirst, readingsFor, type CollectionChoices, type LayerContext } from './flow';
import { isOptionalLayer, type BluetoothReading, type ChangeChallenge, type ChangeOp, type ChangeResult, type OptionalLayerId, type Surface } from './types';

export type ChangeJob =
  | { kind: 'change'; op: ChangeOp; title: string; waive: OptionalLayerId[] }
  /** Trust this device for the vault: device.add with this device's own key, created here (non-extractable) if needed. */
  | { kind: 'trust'; title: string; waive: OptionalLayerId[] };

/** The trust change's name where the app is not known; the sheets say "Set up this browser" or "Set up this computer" (copy.setupTitle). */
export const TRUST_TITLE = 'Set up this device';
export const trustJob = (waive: OptionalLayerId[] = []): ChangeJob => ({ kind: 'trust', title: TRUST_TITLE, waive });

/** A begun change: the server's challenge and what the user may still need to choose or type. */
export interface Draft {
  job: ChangeJob;
  op: ChangeOp;
  challenge: ChangeChallenge;
  /** device.add: the key that signs its own proof of possession. */
  candidate: DeviceKey | null;
  /** ANTARA Desktop, adding a Bluetooth device: connected devices that are not trusted yet. */
  bluetooth: { identifier: string; name: string }[] | null;
  /** ANTARA Desktop, adding a Wi-Fi name: the networks this computer is connected to. */
  wifi: { key: string; name: string }[] | null;
  bluetoothDevice: string;
  wifiConnection: string;
  /** Chrome, adding a Bluetooth device while Bluetooth is on: the trusted device found on an earlier click. */
  bluetoothMatched: BluetoothReading | null;
  /** The 6-digit code typed for this change (MFA on, or adding it). */
  totpCode: string;
  /** The user confirmed a change that waits (its effective time was shown). */
  confirmed: boolean;
}
/** `draft` null: nothing to do for this job (this device turned out to be trusted already). `next`: the change to run after it. */
export interface Prepared { draft: Draft | null; next: ChangeJob | null }

export interface FlowDeps {
  token: () => Promise<string>;
  context: LayerContext;
  /** The name this device gets when it is trusted ("ANTARA Desktop"). */
  deviceLabel: string;
  /** Trusted devices from the last GET /solana/layers, when known: lets the flow trust this device before the first begin. */
  knownDevices?: readonly { keyId: string; surface: Surface; state?: string }[] | null;
}

/** Turning on, or adding to, a layer whose readings come from this device: it must be trusted, for this change or for every later release. */
export function readsFromDevice(op: ChangeOp): boolean {
  return op.type === 'geolocation.add-zone' || op.type === 'bluetooth.add-device' || op.type === 'wifi.add-radio' || op.type === 'wifi.add-bssid';
}

/** Whether this challenge needs a reading signed by a trusted device of this app. */
export function needsDeviceReading(challenge: ChangeChallenge): boolean {
  const needs = readingsFor(challenge);
  return needs.geo || needs.wifi || needs.bluetooth !== null;
}

/** This device's key, when it is one of `devices` (active ones only) for this app. */
export async function trustedHere(context: LayerContext, devices: readonly { keyId: string; surface: Surface; state?: string }[]): Promise<DeviceKey | null> {
  const surface = context.platform.capabilities().surface;
  const key = await loadDeviceKey(context.keys, context.privyUserId, context.multisig);
  if (!key || key.surface !== surface) return null;
  return devices.some(device => device.keyId === key.keyId && device.surface === key.surface && (device.state === undefined || device.state === 'active')) ? key : null;
}

const ALREADY_TRUSTED = /already trusted for this vault/i;

async function draftFor(job: ChangeJob, op: ChangeOp, challenge: ChangeChallenge, candidate: DeviceKey | null, platform: LayerPlatform): Promise<Draft> {
  const capabilities = platform.capabilities();
  let bluetooth: Draft['bluetooth'] = null, wifi: Draft['wifi'] = null;
  if (challenge.capture.bluetooth && capabilities.bluetooth === 'native') {
    // Only devices that are not trusted yet can be added; the trusted ones are read again at finish as the proof.
    const connected = await connectedBluetoothDevices(platform);
    const trusted = await trustedDesktopDevices(readingsFor(challenge).match, challenge.nonce, connected);
    bluetooth = connected.filter(device => !trusted.includes(device));
  }
  if (op.type === 'wifi.add-radio' && challenge.capture.wifi) {
    const current = await collectWifi(platform);
    wifi = current.connections.map((item, index) => ({ key: `${item.ssidHex}/${item.bssid}`, name: `${current.names[index] || 'Hidden network'} · access point ••:${item.bssid.slice(-5)}` }));
  }
  return { job, op, challenge, candidate, bluetooth, wifi, bluetoothDevice: bluetooth?.[0]?.identifier ?? '', wifiConnection: wifi?.[0]?.key ?? '', bluetoothMatched: null, totpCode: '', confirmed: false };
}

/** Begins device.add for this device. Null when the server says this device is trusted already (a stale view). */
async function prepareTrust(job: ChangeJob, deps: FlowDeps): Promise<Draft | null> {
  const { context } = deps;
  const key = await ensureDeviceKey(context.keys, context.privyUserId, context.multisig, context.platform.capabilities().surface);
  const op: ChangeOp = { type: 'device.add', label: deps.deviceLabel, surface: key.surface, publicKeySpki: key.publicKeySpki };
  try {
    const challenge = await beginLayerChange(await deps.token(), context.multisig, op, job.waive);
    return draftFor(job, op, challenge, key, context.platform);
  } catch (failure) {
    if (failure instanceof PairedVaultApiError && failure.code === 'conflict' && ALREADY_TRUSTED.test(failure.message)) return null;
    throw failure;
  }
}

/** A change that needs a reading from this device while it is not set up for the vault, and does not set it up itself. */
export function notSetUpError(surface: Surface): LayerCollectionError {
  const here = surface === 'desktop' ? 'this computer' : 'this browser';
  return new LayerCollectionError('device', `Set up ${here} first. This change needs a reading from it.`, 'add-device');
}

/**
 * Begins one job. When the change itself reads from this device (it adds a safe zone, a Bluetooth device or a Wi-Fi
 * name, so its own form announced the step) and this device is not trusted, the trust change is prepared instead and
 * the change becomes `next` (begun again once the device is trusted, so its challenge lists the new key).
 * Any other change that needs a reading from an untrusted device stops before any prompt with the "add-device" action:
 * the user then chooses to set this device up (security review 2026-10-13: never trust a device the change did not announce).
 */
export async function prepareChange(job: ChangeJob, deps: FlowDeps): Promise<Prepared> {
  const { context } = deps;
  if (job.kind === 'trust') return { draft: await prepareTrust(job, deps), next: null };
  const reads = readsFromDevice(job.op);
  let trustTried = false;
  if (reads && deps.knownDevices && !(await trustedHere(context, deps.knownDevices))) {
    trustTried = true;
    const trust = await prepareTrust(trustJob(), deps);
    if (trust) return { draft: trust, next: job };
  }
  const challenge = await beginLayerChange(await deps.token(), context.multisig, job.op, job.waive);
  if (needsDeviceReading(challenge) && !(await trustedHere(context, challenge.devices))) {
    if (!reads) throw notSetUpError(context.platform.capabilities().surface);
    if (!trustTried) {
      const trust = await prepareTrust(trustJob(), deps);
      if (trust) return { draft: trust, next: job };
    }
  }
  return { draft: await draftFor(job, job.op, challenge, null, context.platform), next: null };
}

/** Finishes a begun change: collects what it needs on this device (passkey last) and sends it. */
export async function completeChange(draft: Draft, deps: FlowDeps): Promise<ChangeResult> {
  const choices: CollectionChoices = {
    candidateKey: draft.candidate,
    bluetoothDevice: draft.bluetooth ? draft.bluetoothDevice : null,
    bluetoothMatched: draft.bluetoothMatched,
    ...(draft.wifi ? { wifiConnection: draft.wifiConnection } : {}),
  };
  return finishLayerChange(deps.token, draft.op, draft.challenge, { ...deps.context, totpCode: needsTotpCode(draft.challenge) ? draft.totpCode : null }, choices);
}

/** Trusts this device for the vault in one go (activation, right after the first passkey). Null when it was trusted already. */
export async function trustThisDevice(deps: FlowDeps): Promise<ChangeResult | null> {
  const prepared = await prepareChange(trustJob(), deps);
  if (!prepared.draft) return null;
  if (pauseFor(prepared.draft, deps.context.platform) !== null) throw new LayerCollectionError('device', 'Trusting this device needs a step only you can take. Turn on a layer to finish it.');
  return completeChange(prepared.draft, deps);
}

/** What only the user can give before this change is finished, or null to finish at once. */
export type Pause = 'recovery' | 'mfa-setup' | 'code' | 'choose-bluetooth' | 'choose-wifi' | 'bluetooth-trusted' | 'bluetooth-chooser';
export function pauseFor(draft: Draft, platform: Pick<LayerPlatform, 'capabilities'>): Pause | null {
  const { challenge } = draft;
  // A change that waits (a 7-day recovery, or a loosening from a server that still delays it) never starts before the user sees when it takes effect.
  if ((challenge.class === 'recovery' || challenge.effectiveAt !== null) && !draft.confirmed) return 'recovery';
  if (challenge.capture.totp) return 'mfa-setup';
  if (draft.bluetooth !== null) return 'choose-bluetooth';
  if (draft.wifi !== null && draft.wifi.length !== 1) return 'choose-wifi';
  if (needsTotpCode(challenge)) return 'code';
  // Chrome opens its Bluetooth chooser only from a click.
  if (readingsFor(challenge).bluetooth !== null && platform.capabilities().bluetooth === 'web-bluetooth') {
    return needsTrustedBluetoothFirst(challenge, platform) && !draft.bluetoothMatched ? 'bluetooth-trusted' : 'bluetooth-chooser';
  }
  return null;
}
/** Whether the paused draft has what it needs for Continue. */
export function canContinue(draft: Draft, pause: Pause): boolean {
  if (needsTotpCode(draft.challenge) && !TOTP_CODE.test(draft.totpCode)) return false;
  if (pause === 'choose-bluetooth') return !!draft.bluetooth?.length && !!draft.bluetoothDevice;
  if (pause === 'choose-wifi') return !!draft.wifi?.length && !!draft.wifiConnection;
  return true;
}

// ---- Steps the sheet shows (at most three) ----------------------------------------------------

export type StepKey = 'trust' | 'read' | 'confirm';
export type StepState = 'waiting' | 'active' | 'done' | 'failed';
export interface FlowStep { key: StepKey; label: string; hint: string; state: StepState }

/** The reading step a change asks of this device, or null. */
export function readStep(op: ChangeOp | null, surface: Surface): Omit<FlowStep, 'state'> | null {
  if (!op) return null;
  const desktop = surface === 'desktop';
  if (op.type === 'geolocation.add-zone' && op.center === 'current') return { key: 'read', label: 'Share your location', hint: desktop ? 'Windows may ask the first time' : 'Your browser asks the first time' };
  if (op.type === 'bluetooth.add-device') return { key: 'read', label: 'Choose your Bluetooth device', hint: desktop ? 'From the devices connected to this computer' : 'Chrome lists the devices nearby' };
  if (op.type === 'wifi.add-radio' || op.type === 'wifi.add-bssid') return { key: 'read', label: 'Read your Wi-Fi network', hint: 'From this computer' };
  if (op.type === 'mfa.add') return { key: 'read', label: 'Scan the code', hint: 'With your authenticator app' };
  return null;
}

/**
 * The steps for a job: set up this device (when needed), the reading, then the passkey. With two passkey prompts the
 * hints count them ("Passkey prompt 1 of 2"), so the second prompt is expected.
 */
export function planSteps(job: ChangeJob, trust: boolean, surface: Surface): FlowStep[] {
  const steps: Omit<FlowStep, 'state'>[] = [];
  const twoPrompts = (trust || job.kind === 'trust') && job.kind === 'change' && job.op.type !== 'passkey.add';
  if (trust || job.kind === 'trust') steps.push({ key: 'trust', label: setupTitle(surface), hint: twoPrompts ? 'Passkey prompt 1 of 2' : 'Confirm with your passkey' });
  if (job.kind === 'change') {
    const read = readStep(job.op, surface);
    if (read) steps.push(read);
    steps.push(job.op.type === 'passkey.add' ? { key: 'confirm', label: 'Create your passkey', hint: 'Fingerprint, face or PIN' }
      : { key: 'confirm', label: 'Confirm with your passkey', hint: twoPrompts ? 'Passkey prompt 2 of 2' : 'Fingerprint, face or PIN' });
  }
  return steps.map(step => ({ ...step, state: 'waiting' as const }));
}

// ---- Problems, in calm words ------------------------------------------------------------------

/** Server refusals (layers/policy.ts) the flow turns into an action: ANTARA's own fixed wording. */
export const PASSKEY_FIRST = /Add a passkey to this vault first/;
export const BLUETOOTH_OTHER_APP = /recovery change that waives Bluetooth/;

const OFFLINE = /failed to fetch|networkerror|load failed|network request failed/i;

export interface FlowProblem {
  message: string;
  action: CollectionAction | null;
  /** Layers that are on and could not be satisfied here: the user may waive them (a 7-day recovery). */
  waivable: OptionalLayerId[];
}

export function lockoutMessage(retryAfterSeconds: number | null | undefined): string {
  const minutes = retryAfterSeconds ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : 15;
  return `Too many checks failed, so ANTARA has paused layer checks for this vault. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** What went wrong, in one calm sentence, with the one action that helps. `enabled`: the optional layers that are on. */
export function flowProblem(failure: unknown, enabled: readonly OptionalLayerId[]): FlowProblem {
  const on = (ids: string[]) => ids.filter((id): id is OptionalLayerId => isOptionalLayer(id) && enabled.includes(id));
  if (failure instanceof PairedVaultApiError) {
    if (failure.code === 'locked') return { message: lockoutMessage(failure.retryAfterSeconds), action: null, waivable: [] };
    if (failure.code === 'conflict' && PASSKEY_FIRST.test(failure.message)) return { message: failure.message, action: 'add-passkey', waivable: [] };
    // Bluetooth devices are trusted per app: this app cannot pass Bluetooth, so the only way is a recovery that waives it.
    if (failure.code === 'conflict' && BLUETOOTH_OTHER_APP.test(failure.message)) return { message: failure.message, action: null, waivable: on(['bluetooth']) };
    const failed = failure.code === 'layer-failed' ? (failure.layers ?? []).filter(item => !item.ok).map(item => item.id) : [];
    return { message: failure.message || 'The change could not be completed. Nothing was changed.', action: null, waivable: on(failed) };
  }
  if (failure instanceof LayerCollectionError) {
    // Failing to capture the new item (cancelling a new passkey, not choosing a device) is never a reason to waive a layer that is on.
    return { message: failure.message, action: failure.action, waivable: failure.layer !== 'device' && !failure.capture ? on([failure.layer]) : [] };
  }
  // The browser could not reach ANTARA's server at all (offline, DNS, CORS): nothing was sent.
  if (failure instanceof TypeError && OFFLINE.test(failure.message)) return { message: 'Couldn’t reach ANTARA just now. Nothing was changed. Check your connection and try again.', action: null, waivable: [] };
  return { message: failure instanceof Error ? friendlyError(failure.message, 'The change could not be completed. Nothing was changed.') : 'The change could not be completed. Nothing was changed.', action: null, waivable: [] };
}
