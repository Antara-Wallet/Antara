import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PairedVaultApiError } from '../vaults/pairedApi';
import { LayerCollectionError } from './collectors';
import { parseChangeChallenge } from './schema';
import { canContinue, flowProblem, needsDeviceReading, pauseFor, planSteps, readsFromDevice, trustJob, type Draft } from './setup';
import { fakePlatform } from './testPlatform';
import { enrollChallengeFixture } from './testFixtures';
import type { ChangeOp } from './types';

const zone: ChangeOp = { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' };
/** A begun change with the fixture's challenge, overridden where a test needs it. */
function draft(overrides: Record<string, unknown> = {}, extra: Partial<Draft> = {}): Draft {
  const base = enrollChallengeFixture();
  const challenge = parseChangeChallenge({ ...base, class: 'tighten', effectiveAt: null, required: [{ id: 'biometrics', evidence: 'passkey' }], webauthn: { get: base.webauthn.get, create: null }, ...overrides }, 'enroll');
  return { job: { kind: 'change', op: zone, title: 'Turn on Safe Zones', waive: [] }, op: zone, challenge, candidate: null, bluetooth: null, wifi: null, bluetoothDevice: '', wifiConnection: '', bluetoothMatched: null, totpCode: '', confirmed: false, ...extra };
}
const web = fakePlatform({ capabilities: { surface: 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false } });

describe('one-click layer changes (setup.ts)', () => {
  it('knows which changes read from this device, from the op before asking and from the challenge after', () => {
    assert.equal(readsFromDevice(zone), true);
    assert.equal(readsFromDevice({ ...zone, center: { lat: 1, lng: 2 } }), true);
    assert.equal(readsFromDevice({ type: 'bluetooth.add-device', label: 'Phone' }), true);
    assert.equal(readsFromDevice({ type: 'wifi.add-network', label: 'Home' }), false);
    assert.equal(readsFromDevice({ type: 'mfa.add', label: 'App' }), false);
    assert.equal(needsDeviceReading(draft({ capture: { geo: true } }).challenge), true);
    assert.equal(needsDeviceReading(draft().challenge), false);
  });

  it('finishes at once unless only the user can give something, and never starts a waiting change unseen', () => {
    assert.equal(pauseFor(draft({ capture: { geo: true } }), web), null);
    // A recovery, or a loosening from a server that still delays it, shows its time first; confirming keeps later pauses.
    assert.equal(pauseFor(draft({ class: 'recovery', effectiveAt: '2026-10-20T10:00:00.000Z' }), web), 'recovery');
    assert.equal(pauseFor(draft({ class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z' }), web), 'recovery');
    const bluetooth = { capture: { bluetooth: 'choose' }, class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z', webauthn: { get: null, create: null },
      required: [{ id: 'bluetooth', evidence: 'device', reading: 'bluetooth', match: [{ surface: 'web', source: 'web-bluetooth', identifier: 'Zm9v', name: 'Pixel 9' }] }] };
    assert.equal(pauseFor(draft(bluetooth, { confirmed: true }), web), 'bluetooth-trusted');
    assert.equal(pauseFor(draft(bluetooth, { confirmed: true, bluetoothMatched: { devices: [{ identifier: 'Zm9v', name: 'Pixel 9' }], at: 1, source: 'web-bluetooth' } }), web), 'bluetooth-chooser');
    // Chrome's chooser needs its own click even when nothing else waits.
    assert.equal(pauseFor(draft({ capture: { bluetooth: 'choose' } }), web), 'bluetooth-chooser');
    // A 6-digit code is typed before anything is collected.
    const code = draft({ class: 'loosen', required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'totp' }] });
    assert.equal(pauseFor(code, web), 'code');
    assert.equal(canContinue(code, 'code'), false);
    assert.equal(canContinue({ ...code, totpCode: '123456' }, 'code'), true);
    // ANTARA Desktop: the Bluetooth device to add is chosen from a list, always shown.
    assert.equal(pauseFor(draft({}, { bluetooth: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }], bluetoothDevice: '001A7DDA7113' }), web), 'choose-bluetooth');
    assert.equal(canContinue(draft({}, { bluetooth: [] }), 'choose-bluetooth'), false);
  });

  it('plans at most three steps, trusting this device first when needed', () => {
    const job = { kind: 'change' as const, op: zone, title: '', waive: [] };
    assert.deepEqual(planSteps(job, true, 'web').map(step => step.label), ['Set up this browser', 'Share your location', 'Confirm with your passkey']);
    // Two passkey prompts are counted, so the second one is expected.
    assert.deepEqual(planSteps(job, true, 'web').map(step => step.hint), ['Passkey prompt 1 of 2', 'Your browser asks the first time', 'Passkey prompt 2 of 2']);
    assert.deepEqual(planSteps(job, true, 'desktop').map(step => step.label)[0], 'Set up this computer');
    assert.deepEqual(planSteps(job, false, 'desktop').map(step => [step.label, step.hint]), [['Share your location', 'Windows may ask the first time'], ['Confirm with your passkey', 'Fingerprint, face or PIN']]);
    assert.deepEqual(planSteps({ ...job, op: { type: 'passkey.add', label: 'Passkey' } }, false, 'web').map(step => step.label), ['Create your passkey']);
    assert.deepEqual(planSteps(trustJob(), false, 'web').map(step => [step.label, step.hint]), [['Set up this browser', 'Confirm with your passkey']]);
    for (const steps of [planSteps(job, true, 'web'), planSteps({ ...job, op: { type: 'bluetooth.add-device', label: 'Phone' } }, true, 'web')]) assert.ok(steps.length <= 3);
  });

  it('turns failures into one calm sentence with the one action that helps, and offers a waiver only for a layer that is on', () => {
    const passkeyFirst = new PairedVaultApiError('Add a passkey to this vault first. Other protection changes are possible once it has one.', 409, 'conflict');
    assert.deepEqual(flowProblem(passkeyFirst, []), { message: passkeyFirst.message, action: 'add-passkey', waivable: [] });
    const otherApp = new PairedVaultApiError('Bluetooth is on, and no trusted Bluetooth device is set up for Web, so this app cannot pass it. Bluetooth devices are trusted per app: add this app as a recovery change that waives Bluetooth (7 days).', 409, 'conflict');
    assert.deepEqual(flowProblem(otherApp, ['bluetooth']).waivable, ['bluetooth']);
    assert.deepEqual(flowProblem(otherApp, []).waivable, []);
    const failed = Object.assign(new PairedVaultApiError('A protection layer did not pass. Nothing was changed.', 403, 'layer-failed'), { layers: [{ id: 'geolocation' as const, ok: false, reason: null }, { id: 'wifi' as const, ok: true, reason: null }] });
    assert.deepEqual(flowProblem(failed, ['geolocation', 'wifi']).waivable, ['geolocation']);
    // Cancelling a new passkey (a capture) or a device-key problem never offers to waive a layer.
    assert.deepEqual(flowProblem(new LayerCollectionError('biometrics', 'Cancelled.', null, true), ['biometrics']).waivable, []);
    assert.deepEqual(flowProblem(new LayerCollectionError('device', 'No key.', 'add-device'), ['geolocation']), { message: 'No key.', action: 'add-device', waivable: [] });
    assert.deepEqual(flowProblem(new LayerCollectionError('geolocation', 'Location access is blocked.'), ['geolocation']).waivable, ['geolocation']);
    // Raw network text never reaches the sheet.
    assert.equal(flowProblem(new TypeError('Failed to fetch'), []).message, 'Couldn’t reach ANTARA just now. Nothing was changed. Check your connection and try again.');
    assert.equal(flowProblem(new Error('{"jsonrpc":"2.0","error":{}}'), []).message, 'The change could not be completed. Nothing was changed.');
    assert.match(flowProblem(Object.assign(new PairedVaultApiError('Locked.', 429, 'locked'), { retryAfterSeconds: 120 }), []).message, /about 2 minutes/);
  });
});
