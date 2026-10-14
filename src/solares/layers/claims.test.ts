import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as claims from './claims';
import { CHECKED_BY, ENROLL_OFFERS, KIND_LABELS, LAYER_NAMES, NEVER_CLAIM, checkedByLines, expectedKinds } from './claims';
import { layerGate, passkeyEnrolled, pendingNotices, pendingSentence } from './gate';
import { parseVaultLayers } from './schema';
import { FIXTURE_MULTISIG, emptyLayersFixture, layersFixture, recoveryPendingFixture } from './testFixtures';
import { LAYER_IDS } from './types';

/** Every string the claims module exports, however deeply nested. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object' && !(value instanceof RegExp)) return Object.values(value).flatMap(strings);
  return [];
}

describe('honest claims (section 14)', () => {
  it('covers all six layers in landing order, with the owner’s three badge names', () => {
    assert.deepEqual(Object.keys(LAYER_NAMES), [...LAYER_IDS]);
    assert.deepEqual(Object.values(KIND_LABELS), ['Cryptographic', 'Device-reported', 'Server-observed']);
    for (const id of LAYER_IDS) {
      assert.ok(checkedByLines({ id, status: 'enrolled', mode: 'network' }, 'desktop').length > 0, id);
      assert.deepEqual(checkedByLines({ id, status: 'not-enrolled', mode: null }, 'desktop'), [], id);
      assert.ok(id in ENROLL_OFFERS, id);
    }
  });

  it('binds each layer to the kinds it may honestly carry', () => {
    assert.deepEqual(expectedKinds('biometrics', null), ['cryptographic']);
    assert.deepEqual(expectedKinds('mfa', null), ['cryptographic']);
    assert.deepEqual(expectedKinds('limits', null), ['cryptographic']);
    assert.deepEqual(expectedKinds('geolocation', null), ['device-reported']);
    assert.deepEqual(expectedKinds('bluetooth', null), ['device-reported']);
    assert.deepEqual(expectedKinds('wifi', 'network'), ['server-observed']);
    assert.deepEqual(expectedKinds('wifi', 'network+radio'), ['server-observed', 'device-reported']);
  });

  it('uses the exact section 14.1 lines per surface', () => {
    assert.deepEqual(checkedByLines({ id: 'bluetooth', status: 'enrolled', mode: null }, 'desktop'), [CHECKED_BY.bluetoothDesktop]);
    assert.deepEqual(checkedByLines({ id: 'bluetooth', status: 'enrolled', mode: null }, 'extension'), [CHECKED_BY.bluetoothBrowser]);
    assert.deepEqual(checkedByLines({ id: 'wifi', status: 'pending-removal', mode: 'network+radio' }, 'web'), [CHECKED_BY.wifiNetwork, CHECKED_BY.wifiRadio]);
    assert.equal(CHECKED_BY.all, "ANTARA's guardian votes only after every layer you turned on passes for this exact release. Layers are checked by ANTARA's server; a compromised ANTARA server could skip them.");
    assert.equal(CHECKED_BY.notifications, 'ANTARA does not send notifications about pending changes. Check this screen.');
    // What a stolen session alone can still do (server: recovery passkey after 7 days, which can then remove the original; owner decision 2026-10-13 removed the extra wait).
    assert.equal(CHECKED_BY.sessionRecovery, 'Someone holding your session can add a passkey through recovery; it takes effect after 7 days unless you cancel it, and can then be used to remove your original passkey.');
  });

  it('never makes a section 14.2 claim anywhere in the module', () => {
    const everything = strings(Object.fromEntries(Object.entries(claims).filter(([name]) => name !== 'NEVER_CLAIM')));
    assert.ok(everything.length > 30);
    for (const text of everything) for (const pattern of NEVER_CLAIM) assert.doesNotMatch(text, pattern, text);
    // The patterns themselves catch what they are meant to.
    for (const text of ['A fingerprint is required', 'per-transaction MFA', 'GPS verified', 'Wi-Fi verified', 'proximity verified', 'hardware-backed key', 'voice check']) {
      assert.ok(NEVER_CLAIM.some(pattern => pattern.test(text)), text);
    }
  });
});

describe('vault gate (owner decision: a passkey is required)', () => {
  it('pauses deposits and releases until the layers answer', () => {
    assert.equal(layerGate({ status: 'loading' }).stage, 'checking');
    assert.ok(layerGate({ status: 'idle' }).releaseBlock);
    const unavailable = layerGate({ status: 'unavailable', code: 'not-provisioned', message: 'Off.' });
    assert.equal(unavailable.stage, 'unavailable');
    assert.match(unavailable.depositBlock, /paused/);
  });
  it('asks for a passkey to finish activation, and a pending passkey does not count', () => {
    const empty = parseVaultLayers(emptyLayersFixture(), FIXTURE_MULTISIG);
    assert.equal(passkeyEnrolled(empty), false);
    assert.equal(layerGate({ status: 'ready', view: empty, refreshing: false }).stage, 'activate-passkey');
    const pendingOnly = emptyLayersFixture();
    pendingOnly.layers[2] = { id: 'biometrics', kinds: ['cryptographic'], status: 'not-enrolled', enforced: true,
      items: [{ id: 'Y3JlZA', type: 'passkey', label: 'Phone', detail: 'Synced passkey · added from Web', state: 'pending-addition', effectiveAt: '2026-10-14T09:00:00.000Z', changeId: 'chg_a1' }] };
    assert.equal(passkeyEnrolled(parseVaultLayers(pendingOnly, FIXTURE_MULTISIG)), false);
    // A first passkey added outside the activation window is a 7-day recovery change: still paused, and the owner is told when and how to cancel.
    const pendingGate = layerGate({ status: 'ready', view: parseVaultLayers(pendingOnly, FIXTURE_MULTISIG), refreshing: false });
    assert.equal(pendingGate.stage, 'activate-passkey');
    assert.equal(pendingGate.firstPasskeyAt, Date.parse('2026-10-14T09:00:00.000Z'));
    assert.match(pendingGate.releaseBlock, /^Releases are paused until this vault’s first passkey takes effect on .+ If you did not add it, cancel it/);
    assert.match(pendingGate.depositBlock, /^Deposits are paused until/);
    assert.equal(layerGate({ status: 'ready', view: empty, refreshing: false }).firstPasskeyAt, null);
    const ready = layerGate({ status: 'ready', view: parseVaultLayers(layersFixture(), FIXTURE_MULTISIG), refreshing: false });
    assert.deepEqual(ready, { stage: 'ready', releaseBlock: '', depositBlock: '', firstPasskeyAt: null });
  });
  it('warns about pending weakening changes outside settings, from fixed text only', () => {
    const view = parseVaultLayers(recoveryPendingFixture('Backup 10.0.0.1'), FIXTURE_MULTISIG);
    const pending = pendingNotices({ status: 'ready', view, refreshing: false });
    assert.deepEqual(pending.map(item => item.id), ['chg_b2', 'chg_r7']);
    const sentences = pending.map(pendingSentence);
    assert.match(sentences[0], /^A change that weakens this vault’s protection takes effect on .+ \(loosens a layer you have on\)\.$/);
    assert.match(sentences[1], /\(recovery: waives Biometrics\)\.$/);
    // The user-chosen label never reaches the warning, and the warning claims nothing about the layers.
    for (const text of sentences) {
      assert.doesNotMatch(text, /Backup|10\.0\.0\.1/);
      for (const pattern of NEVER_CLAIM) assert.doesNotMatch(text, pattern);
    }
    assert.match(pendingSentence({ id: 'chg_x', class: 'recovery', effectiveAt: 0, waived: null }), /\(recovery\)\.$/);
    // A view that could not be shown still warns; nothing else does.
    const notice = { id: 'chg_r7', class: 'recovery' as const, effectiveAt: 1, waived: null };
    assert.deepEqual(pendingNotices({ status: 'unavailable', code: 'unavailable', message: 'x', pending: [notice] }), [notice]);
    assert.deepEqual(pendingNotices({ status: 'unavailable', code: 'not-provisioned', message: 'x' }), []);
    assert.deepEqual(pendingNotices({ status: 'loading' }), []);
  });
});
