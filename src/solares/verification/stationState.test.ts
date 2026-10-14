import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEVER_CLAIM } from '../layers/claims';
import type { VaultLayersLoad } from '../layers/gate';
import { parseReleaseChallenge, parseVaultLayers } from '../layers/schema';
import { FIXTURE_MULTISIG, emptyLayersFixture, layersFixture, releaseChallengeFixture } from '../layers/testFixtures';
import { LAYER_IDS, type LayerId, type LayerRequirement } from '../layers/types';
import { STATION_VISUALS, overviewStations, stationLabel, stationStates, stationVisuals, type StationPhase, type StationVisual } from './stationState';

const ready = (view = layersFixture()): VaultLayersLoad => ({ status: 'ready', view: parseVaultLayers(view, FIXTURE_MULTISIG), refreshing: false });
const required = (): LayerRequirement[] => parseReleaseChallenge(releaseChallengeFixture(), FIXTURE_MULTISIG, '12').required;
const release = (overrides: Partial<Extract<StationPhase, { kind: 'release' }>> = {}): StationPhase => ({
  kind: 'release', layers: ready(), required: required(), collecting: null, collected: [], submitted: false, result: null, ...overrides,
});
const byId = (visuals: StationVisual[]) => Object.fromEntries(LAYER_IDS.map((id, index) => [id, visuals[index]])) as Record<LayerId, StationVisual>;
const NOT_READY: VaultLayersLoad[] = [
  { status: 'idle' }, { status: 'loading' },
  { status: 'unavailable', code: 'unavailable', message: 'Protection layers cannot be shown right now.' },
  { status: 'unavailable', code: 'not-provisioned', message: 'ANTARA’s vault guardian is not switched on for this server.' },
];

test('rule 1: without a ready layer read every station is unknown, in every phase', () => {
  for (const layers of NOT_READY) {
    const phases: StationPhase[] = [
      { kind: 'overview', layers }, { kind: 'activation', layers },
      { ...release(), layers }, { ...release({ submitted: true }), layers }, { ...release({ result: { kind: 'approved-with-evidence' } }), layers },
      { ...release({ result: { kind: 'failed', results: [{ id: 'geolocation', ok: false, reason: 'Outside every safe zone.' }] } }), layers },
    ];
    for (const phase of phases) {
      assert.deepEqual(stationVisuals(phase), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'], `${phase.kind} with ${layers.status}`);
      assert.ok(stationStates(phase).every(item => item.label === ''), 'unknown stations carry no text');
    }
  }
});

test('rule 2: overview and activation follow the server status, in landing order', () => {
  // layersFixture: Bluetooth off, Wi-Fi on, Biometrics on, Safe Zones pending removal, MFA on, Limits on.
  for (const kind of ['overview', 'activation'] as const) {
    assert.deepEqual(stationVisuals({ kind, layers: ready() }), ['off', 'on', 'on', 'pending-removal', 'on', 'on']);
  }
  const labels = overviewStations(ready()).map(item => item.label);
  assert.deepEqual(labels.slice(0, 3), ['Off', 'On', 'On']);
  assert.match(labels[3], /^Turning off \S/);
  assert.deepEqual(labels.slice(4), ['On', 'On']);
  // A vault with no optional layer yet (a passkey still needed): everything off. MFA (the vault authenticator) and Limits
  // (caps you set, owner decision 2026-10-13) are off until set up.
  assert.deepEqual(stationVisuals({ kind: 'activation', layers: ready(emptyLayersFixture()) }), ['off', 'off', 'off', 'off', 'off', 'off']);
});

test('rule 2: MFA (the vault authenticator) not set up is "Off", never paused or failed (no Privy MFA, 2026-10-13)', () => {
  const view = layersFixture();
  view.layers[4] = { id: 'mfa', kinds: ['cryptographic'], status: 'not-enrolled', enforced: false, items: [] };
  const states = overviewStations(ready(view));
  assert.equal(states[4].visual, 'off');
  assert.equal(states[4].label, 'Off');
});

test('rule 3: a required layer starts required; layers not required keep their overview', () => {
  const challenge = required().filter(item => item.id === 'biometrics' || item.id === 'mfa' || item.id === 'limits');
  const visuals = byId(stationVisuals(release({ required: challenge })));
  assert.equal(visuals.biometrics, 'required');
  assert.equal(visuals.mfa, 'required');
  assert.equal(visuals.limits, 'required');
  assert.equal(visuals.bluetooth, 'off');
  assert.equal(visuals.wifi, 'on');
  assert.equal(visuals.geolocation, 'pending-removal');
});

test('rule 3: collecting and collected only for layers read on this device; server evidence stays required', () => {
  const reading = byId(stationVisuals(release({ collecting: 'geolocation', collected: ['bluetooth'] })));
  assert.equal(reading.geolocation, 'collecting');
  assert.equal(reading.bluetooth, 'collected');
  assert.equal(reading.biometrics, 'required');
  const all = byId(stationVisuals(release({ collected: [...LAYER_IDS] })));
  assert.equal(all.bluetooth, 'collected');
  assert.equal(all.geolocation, 'collected');
  assert.equal(all.biometrics, 'collected');
  // Wi-Fi network, MFA and Limits are server evidence in this challenge.
  assert.equal(all.wifi, 'required');
  assert.equal(all.mfa, 'required');
  assert.equal(all.limits, 'required');
  // Wi-Fi with a desktop radio reading is read on this device.
  const radio: LayerRequirement[] = [...required(), { id: 'wifi', evidence: 'device', reading: 'wifi', match: [], desktopOnly: true }];
  assert.equal(byId(stationVisuals(release({ required: radio, collected: ['wifi'] }))).wifi, 'collected');
});

test('rule 3: before submit a station is only required, collecting or collected; never passed or failed', () => {
  for (const collecting of [null, ...LAYER_IDS]) {
    for (const visual of stationVisuals(release({ collecting, collected: ['bluetooth', 'biometrics'] }))) {
      assert.ok(['required', 'collecting', 'collected', 'off', 'on', 'pending-removal'].includes(visual), visual);
    }
  }
});

test('rule 3: after submit required stations are checking; others keep the overview', () => {
  const visuals = stationVisuals(release({ submitted: true, collected: ['bluetooth'] }));
  assert.deepEqual(visuals, ['checking', 'checking', 'checking', 'checking', 'checking', 'checking']);
  const partial = byId(stationVisuals(release({ submitted: true, required: required().filter(item => item.id === 'biometrics') })));
  assert.equal(partial.biometrics, 'checking');
  assert.equal(partial.bluetooth, 'off');
});

test('rule 3: approved with evidence passes every required station at once', () => {
  const challenge = required().filter(item => item.id !== 'bluetooth');
  const visuals = byId(stationVisuals(release({ required: challenge, submitted: true, result: { kind: 'approved-with-evidence' } })));
  for (const id of ['wifi', 'biometrics', 'geolocation', 'mfa', 'limits'] as const) assert.equal(visuals[id], 'passed', id);
  assert.equal(visuals.bluetooth, 'off');
});

test('rule 3: approved without a new check never yields passed', () => {
  for (const phase of [
    release({ result: { kind: 'approved-no-new-check' } }),
    release({ required: [], result: { kind: 'approved-no-new-check' } }),
    release({ submitted: true, collected: [...LAYER_IDS], result: { kind: 'approved-no-new-check' } }),
  ]) {
    const visuals = stationVisuals(phase);
    assert.ok(!visuals.includes('passed'));
    assert.deepEqual(visuals, stationVisuals({ kind: 'overview', layers: phase.layers }));
  }
});

test('rule 3: a failed answer is mapped per layer; absent required layers stay required as "Not checked"', () => {
  const phase = release({
    submitted: true,
    result: { kind: 'failed', results: [
      { id: 'geolocation', ok: false, reason: 'Your reported location is outside every safe zone.' },
      { id: 'biometrics', ok: true, reason: null },
      { id: 'mfa', ok: true, reason: null },
    ] },
  });
  const states = Object.fromEntries(stationStates(phase).map(item => [item.id, item]));
  assert.equal(states.geolocation.visual, 'failed');
  assert.equal(states.geolocation.label, 'Your reported location is outside every safe zone.');
  assert.equal(states.biometrics.visual, 'passed');
  assert.equal(states.biometrics.label, 'Passed');
  assert.equal(states.mfa.label, 'Passed · code checked');
  for (const id of ['bluetooth', 'wifi', 'limits'] as const) {
    assert.equal(states[id].visual, 'required', id);
    assert.equal(states[id].label, 'Not checked', id);
  }
});

test('rule 3: a device-side collection error returns the layer to required, never failed', () => {
  // The container clears `collecting` (and the attempt's readings) when a collector throws; nothing was sent.
  const during = byId(stationVisuals(release({ collecting: 'geolocation', collected: ['bluetooth'] })));
  assert.equal(during.geolocation, 'collecting');
  const after = stationVisuals(release({ collecting: null, collected: [] }));
  assert.ok(!after.includes('failed'));
  assert.equal(byId(after).geolocation, 'required');
});

test('rule 4: labels are exact', () => {
  assert.equal(stationLabel('bluetooth', 'unknown'), '');
  assert.equal(stationLabel('bluetooth', 'off'), 'Off');
  assert.equal(stationLabel('bluetooth', 'on'), 'On');
  assert.equal(stationLabel('bluetooth', 'required'), 'Required');
  assert.equal(stationLabel('bluetooth', 'required', undefined, { notChecked: true }), 'Not checked');
  assert.equal(stationLabel('geolocation', 'collecting'), 'Reading on this device…');
  assert.equal(stationLabel('geolocation', 'collected'), 'Ready to send');
  assert.equal(stationLabel('geolocation', 'checking'), 'ANTARA is checking…');
  assert.equal(stationLabel('geolocation', 'passed'), 'Passed');
  assert.equal(stationLabel('mfa', 'passed'), 'Passed · code checked');
  assert.equal(stationLabel('wifi', 'passed'), 'Passed · network check');
  assert.equal(stationLabel('wifi', 'passed', undefined, { wifiRadio: true }), 'Passed');
  assert.equal(stationLabel('mfa', 'failed'), 'Did not pass');
  assert.equal(stationLabel('mfa', 'failed', undefined, { reason: 'That authenticator code is wrong, expired or already used.' }), 'That authenticator code is wrong, expired or already used.');
  assert.equal(stationLabel('geolocation', 'failed', undefined, { reason: 'Outside every safe zone.' }), 'Outside every safe zone.');
  const view = parseVaultLayers(layersFixture(), FIXTURE_MULTISIG);
  const geolocation = view.layers[3];
  assert.equal(stationLabel('geolocation', 'pending-removal', geolocation), `Turning off ${new Date(geolocation.effectiveAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  // Collected is "Ready to send", never a claim that anything was verified.
  assert.doesNotMatch(stationLabel('geolocation', 'collected'), /verif/i);
});

test('every label this module can produce passes NEVER_CLAIM', () => {
  const view = parseVaultLayers(layersFixture(), FIXTURE_MULTISIG);
  const labels = new Set<string>();
  for (const id of LAYER_IDS) {
    for (const visual of STATION_VISUALS) {
      for (const layer of [undefined, view.layers.find(item => item.id === id)]) {
        for (const context of [{}, { notChecked: true }, { wifiRadio: true }, { wifiRadio: false }, { reason: null }]) labels.add(stationLabel(id, visual, layer, context));
      }
    }
  }
  for (const label of labels) {
    for (const pattern of NEVER_CLAIM) assert.doesNotMatch(label, pattern, label);
    assert.doesNotMatch(label, /verified location|Wi-Fi verified|proximity|\bTPM\b|\d+\s?m\b|metres|meters|per[- ]transaction/i, label);
  }
});
