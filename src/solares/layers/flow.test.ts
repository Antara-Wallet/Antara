import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LayerCollectionError } from './collectors';
import { ensureDeviceKey, memoryDeviceKeyStorage } from './deviceKey';
import { fetchVaultLayers } from './api';
import {
  assertChallengeBinding, beginLayerChange, checkTrustedBluetooth, collectEvidence, needsTrustedBluetoothFirst, startReleaseApproval, submitReleaseApproval, type LayerContext,
} from './flow';
import { LayerViewError, parseChangeChallenge, parseReleaseChallenge } from './schema';
import { FIXTURE_BLUETOOTH_MATCH, FIXTURE_MULTISIG, FIXTURE_RECIPIENT, FIXTURE_USER, enrollChallengeFixture, recoveryPendingFixture, releaseChallengeFixture } from './testFixtures';
import { FakeNativeError, fakePlatform, type FakePlatformOverrides } from './testPlatform';
import { PairedVaultApiError } from '../vaults/pairedApi';
import type { ReleaseChallenge } from './types';

const passkeyResponse = { id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key' as const, response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: undefined }, clientExtensionResults: {} };
const desktopNative = (calls: string[]): FakePlatformOverrides['native'] => ({
  connectedBluetooth: async () => { calls.push('bluetooth'); return [{ id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' }, { id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' }]; },
  location: async () => { calls.push('location'); return { lat: 48.85, lng: 2.35, accuracyM: 20, at: 1_791_892_795_000 }; },
  passkeyGet: async () => { calls.push('passkeyGet'); return passkeyResponse; },
});

async function setup(overrides: FakePlatformOverrides = {}, calls: string[] = []) {
  const keys = memoryDeviceKeyStorage();
  const platform = fakePlatform({ native: desktopNative(calls), ...overrides }, calls);
  const key = await ensureDeviceKey(keys, FIXTURE_USER, FIXTURE_MULTISIG, platform.capabilities().surface);
  const challenge: ReleaseChallenge = { ...parseReleaseChallenge(releaseChallengeFixture(), FIXTURE_MULTISIG, '12'), devices: [{ keyId: key.keyId, surface: key.surface }] };
  const context: LayerContext = { platform, keys, privyUserId: FIXTURE_USER, multisig: FIXTURE_MULTISIG };
  return { keys, platform, key, challenge, context, calls };
}

type Call = { path: string; body: unknown };
const realFetch = globalThis.fetch;
function stubFetch(answer: (path: string, body: unknown) => { status: number; json: unknown; headers?: Record<string, string> }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api\/solares\/paired-vault/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const result = answer(path, body);
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json', ...result.headers } });
  }) as typeof fetch;
  return calls;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe('evidence collection (section 12 step 5)', () => {
  it('reports each layer read on this device in collection order (8.7), without changing what is collected', async () => {
    const { challenge, context, calls } = await setup();
    const events: string[] = [];
    const evidence = await collectEvidence(challenge, { ...context, onLayer: (id, phase) => { events.push(`${id}:${phase}`); } });
    assert.deepEqual(events, ['bluetooth:collecting', 'bluetooth:collected', 'geolocation:collecting', 'geolocation:collected', 'biometrics:collecting', 'biometrics:collected']);
    assert.deepEqual(calls, ['bluetooth', 'location', 'passkeyGet']);
    assert.equal(evidence.totp, undefined, 'MFA is not asked for while the vault authenticator is off');
  });
  it('asks for the vault authenticator code before any prompt, and sends it with the evidence', async () => {
    const { challenge: base, context, calls } = await setup();
    const challenge: ReleaseChallenge = { ...base, required: base.required.map(item => item.id === 'mfa' ? { ...item, evidence: 'totp' as const } : item) };
    for (const code of [undefined, '', '12345', '12a456']) {
      await assert.rejects(collectEvidence(challenge, { ...context, totpCode: code }), (error: unknown) => error instanceof LayerCollectionError && error.layer === 'mfa' && /6-digit code/.test(error.message));
    }
    assert.deepEqual(calls, [], 'nothing was asked of the device');
    const evidence = await collectEvidence(challenge, { ...context, totpCode: ' 123456 ' });
    assert.deepEqual(evidence.totp, { code: '123456' });
  });

  it('collects Bluetooth first, then location, then the passkey last, and signs one device payload', async () => {
    const { challenge, context, calls, key } = await setup();
    const evidence = await collectEvidence(challenge, context);
    assert.deepEqual(calls, ['bluetooth', 'location', 'passkeyGet']);
    assert.equal(evidence.passkey?.id, 'Y3JlZA');
    const payload = JSON.parse(Buffer.from(evidence.device!.payload, 'base64url').toString('utf8'));
    assert.equal(payload.keyId, key.keyId);
    assert.equal(payload.challengeId, challenge.challengeId);
    assert.equal(payload.nonce, challenge.nonce);
    assert.equal(payload.digest, challenge.digest);
    assert.equal(payload.purpose, 'release');
    assert.deepEqual(payload.bluetooth.devices, [{ identifier: '001A7DDA7113', name: 'Pixel 9' }]);
    assert.equal(payload.wifi, undefined);
    assert.equal(payload.geo.source, 'windows-location');
  });

  it('stops at the first failed reading: no passkey prompt, nothing to send', async () => {
    const calls: string[] = [];
    const { challenge, context } = await setup({ native: { ...desktopNative(calls), location: async () => { calls.push('location'); throw new FakeNativeError('location-consent-required'); } } }, calls);
    const failure = await collectEvidence(challenge, context).catch(error => error);
    assert.ok(failure instanceof LayerCollectionError);
    assert.equal(failure.layer, 'geolocation');
    assert.deepEqual(calls, ['bluetooth', 'location']);
  });

  it('checks the trusted device key before any prompt', async () => {
    const { challenge, context, calls } = await setup();
    const untrusted = await collectEvidence({ ...challenge, devices: [] }, context).catch(error => error);
    assert.equal(untrusted.action, 'add-device');
    const noKey = await collectEvidence(challenge, { ...context, keys: memoryDeviceKeyStorage() }).catch(error => error);
    assert.equal(noKey.action, 'add-device');
    const otherSurface = await collectEvidence(challenge, { ...context, platform: fakePlatform({ capabilities: { surface: 'web' }, native: desktopNative(calls) }) }).catch(error => error);
    assert.equal(otherSurface.action, 'add-device');
    assert.deepEqual(calls, []);
  });

  it('hands off to the full tab in the extension side panel, and refuses a desktop-only Wi-Fi requirement elsewhere', async () => {
    const { challenge, context } = await setup();
    const panel = await collectEvidence(challenge, { ...context, platform: fakePlatform({ capabilities: { ceremonyInline: false } }) }).catch(error => error);
    assert.equal(panel.action, 'open-full-tab');
    const radio = { ...challenge, required: [...challenge.required, { id: 'wifi' as const, evidence: 'device' as const, reading: 'wifi' as const, match: [], desktopOnly: true }] };
    await assert.rejects(collectEvidence(radio, { ...context, platform: fakePlatform({ capabilities: { surface: 'web', passkey: 'browser', bluetooth: 'web-bluetooth', geolocation: 'browser', wifiRadio: false } }) }), /requires ANTARA Desktop/);
  });

  it('sends no device payload and no prompt when only server-checked layers are required', async () => {
    const { challenge, context, calls } = await setup();
    const evidence = await collectEvidence({ ...challenge, required: challenge.required.filter(item => item.evidence === 'server'), webauthn: null }, context);
    assert.deepEqual(evidence, {});
    assert.deepEqual(calls, []);
  });

  it('refuses a passkey request that is not bound to this nonce and digest', async () => {
    const { challenge } = await setup();
    await assertChallengeBinding(challenge);
    await assert.rejects(assertChallengeBinding({ ...challenge, webauthn: { ...challenge.webauthn!, challenge: 'A'.repeat(43) } }), /does not match this action/);
    await assert.rejects(assertChallengeBinding({ ...challenge, digest: '0'.repeat(64) }), /does not match this action/);
  });
});

describe('release approval with layers (section 12 steps 1 to 7)', () => {
  const onDevice = { asset: 'SOL' as const, amountRaw: '250000000', recipient: FIXTURE_RECIPIENT };
  const token = async () => 'token';

  it('keeps today’s flow when the guardian approves without layers', async () => {
    const calls = stubFetch(() => ({ status: 200, json: { status: 'already-approved' } }));
    const started = await startReleaseApproval(token, FIXTURE_MULTISIG, '12', async () => onDevice, fakePlatform());
    assert.deepEqual(started, { kind: 'approved', approval: { status: 'already-approved' } });
    assert.deepEqual(calls, [{ path: '/solana/approve', body: { multisig: FIXTURE_MULTISIG, transactionIndex: '12' } }]);
  });

  it('begins the layer step on layers-required, after checking the release on this device', async () => {
    const order: string[] = [];
    stubFetch(path => {
      order.push(path);
      return path === '/solana/approve' ? { status: 403, json: { error: 'Verify your protection layers.', code: 'layers-required', required: [{ id: 'biometrics', evidence: 'passkey' }] } }
        : { status: 200, json: releaseChallengeFixture() };
    });
    const started = await startReleaseApproval(token, FIXTURE_MULTISIG, '12', async () => { order.push('read'); return onDevice; }, fakePlatform());
    assert.equal(started.kind, 'verify');
    assert.deepEqual(order, ['/solana/approve', '/solana/layers/approval/begin', 'read']);
  });

  it('aborts before any prompt when the server describes a different release', async () => {
    stubFetch(path => path === '/solana/approve' ? { status: 403, json: { error: 'x', code: 'layers-required' } } : { status: 200, json: releaseChallengeFixture({ amountRaw: '250000001' }) });
    await assert.rejects(startReleaseApproval(token, FIXTURE_MULTISIG, '12', async () => onDevice, fakePlatform()), /server described a different release\. Nothing was approved/);
  });

  it('hands off from the side panel without beginning, and rethrows every other refusal', async () => {
    const calls = stubFetch(() => ({ status: 403, json: { error: 'x', code: 'layers-required' } }));
    assert.deepEqual(await startReleaseApproval(token, FIXTURE_MULTISIG, '12', async () => onDevice, fakePlatform({ capabilities: { ceremonyInline: false } })), { kind: 'full-tab' });
    assert.equal(calls.length, 1);
    stubFetch(() => ({ status: 403, json: { error: 'Denied.', code: 'denied' } }));
    await assert.rejects(startReleaseApproval(token, FIXTURE_MULTISIG, '12', async () => onDevice, fakePlatform()), (error: unknown) => error instanceof PairedVaultApiError && error.code === 'denied');
  });

  it('sends the evidence with the approval and surfaces layer failures', async () => {
    const { challenge, context } = await setup();
    const calls = stubFetch(() => ({ status: 403, json: { error: 'A protection layer did not pass.', code: 'layer-failed', layers: [{ id: 'geolocation', ok: false, reason: 'Your reported location is outside your safe zones.' }, { id: 'biometrics', ok: true }] } }));
    const failure = await submitReleaseApproval(token, challenge, context).catch(error => error);
    assert.ok(failure instanceof PairedVaultApiError);
    assert.equal(failure.code, 'layer-failed');
    assert.deepEqual(failure.layers?.map(item => item.ok), [false, true]);
    const body = calls[0].body as { multisig: string; transactionIndex: string; layers: Record<string, unknown> };
    assert.equal(calls[0].path, '/solana/approve');
    assert.deepEqual(Object.keys(body), ['multisig', 'transactionIndex', 'layers']);
    assert.deepEqual(Object.keys(body.layers), ['challengeId', 'passkey', 'device']);
    assert.equal(body.layers.challengeId, challenge.challengeId);
  });

  it('reports a lockout with its retry time', async () => {
    const { challenge, context } = await setup();
    stubFetch(() => ({ status: 429, json: { error: 'Locked.', code: 'locked' }, headers: { 'Retry-After': '600' } }));
    const failure = await submitReleaseApproval(token, challenge, context).catch(error => error);
    assert.equal(failure.retryAfterSeconds, 600);
    // Cross-origin callers cannot read an unexposed Retry-After; the body value is used then.
    stubFetch(() => ({ status: 429, json: { error: 'Locked.', code: 'locked', retryAfterSeconds: 420 } }));
    assert.equal((await submitReleaseApproval(token, challenge, context).catch(error => error)).retryAfterSeconds, 420);
  });
});

describe('adding a Bluetooth device while Bluetooth is on (a loosening, section 8.1)', () => {
  const addDevice = (surface: 'desktop' | 'web', keyId: string) => parseChangeChallenge({
    ...enrollChallengeFixture(), devices: [{ keyId, surface }], webauthn: { get: null, create: null }, capture: { bluetooth: 'choose' },
    required: [
      { id: 'bluetooth', evidence: 'device', reading: 'bluetooth', match: [
        { surface: 'desktop', source: 'windows-classic', identifier: FIXTURE_BLUETOOTH_MATCH, name: '' },
        { surface: 'web', source: 'web-bluetooth', identifier: 'Zm9vYmFy', name: 'Pixel 9' },
      ] },
      { id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' },
    ],
  }, 'enroll');
  const devicesIn = (evidence: { device?: { payload: string } }) => JSON.parse(Buffer.from(evidence.device!.payload, 'base64url').toString('utf8')).bluetooth;

  it('desktop signs the connected trusted device and the chosen new one in one reading', async () => {
    const { context, key } = await setup();
    const challenge = addDevice('desktop', key.keyId);
    assert.equal(needsTrustedBluetoothFirst(challenge, context.platform), false);
    const evidence = await collectEvidence(challenge, context, { bluetoothDevice: 'A1B2C3D4E5F6' });
    assert.deepEqual(devicesIn(evidence), { devices: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }, { identifier: 'A1B2C3D4E5F6', name: 'Headphones' }], at: 1_791_892_800_000, source: 'windows-classic' });
  });

  it('Chrome finds the trusted device on a first click, then signs it with the new device chosen on the second', async () => {
    const calls: string[] = [];
    const requestDevice = async (options: { filters: { name: string }[] } | { acceptAllDevices: true }) => {
      calls.push('filters' in options ? 'trusted' : 'any');
      return 'filters' in options ? { id: 'Zm9vYmFy', name: 'Pixel 9' } : { id: 'bmV3', name: 'Headphones' };
    };
    const web = { capabilities: { surface: 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false } as const, browser: { bluetooth: () => ({ requestDevice }) } };
    const { context, key } = await setup(web, calls);
    const challenge = addDevice('web', key.keyId);
    assert.equal(needsTrustedBluetoothFirst(challenge, context.platform), true);
    // Without the first click, nothing is asked for and nothing is signed.
    await assert.rejects(collectEvidence(challenge, context), /trusted Bluetooth device first/);
    assert.deepEqual(calls, []);
    const matched = await checkTrustedBluetooth(challenge, context);
    const evidence = await collectEvidence(challenge, context, { bluetoothMatched: matched });
    assert.deepEqual(calls, ['trusted', 'any']);
    assert.deepEqual(devicesIn(evidence).devices, [{ identifier: 'Zm9vYmFy', name: 'Pixel 9' }, { identifier: 'bmV3', name: 'Headphones' }]);
    // An untrusted device key is refused before the first chooser opens.
    await assert.rejects(checkTrustedBluetooth({ ...challenge, devices: [] }, context), /isn’t trusted for this vault yet/);
    assert.deepEqual(calls, ['trusted', 'any']);
  });
});

describe('a layer view that cannot be shown', () => {
  it('keeps its pending changes so the wallet can still warn and offer Cancel', async () => {
    const leaky = recoveryPendingFixture('Phone');
    (leaky.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32';
    stubFetch(() => ({ status: 200, json: leaky }));
    const failure = await fetchVaultLayers('token', FIXTURE_MULTISIG).catch(error => error);
    assert.ok(failure instanceof LayerViewError);
    assert.match(failure.message, /unexpected layer response/);
    assert.deepEqual(failure.pending.map(item => [item.id, item.class, item.waived]), [['chg_b2', 'loosen', []], ['chg_r7', 'recovery', ['biometrics']]]);
    stubFetch(() => ({ status: 200, json: recoveryPendingFixture('Backup 10.0.0.1') }));
    assert.equal((await fetchVaultLayers('token', FIXTURE_MULTISIG)).pending[1].summary, 'Add passkey "Backup 10.0.0.1"');
  });
});

describe('changes', () => {
  it('begins enrollment through the enroll route and checks the passkey registration binding', async () => {
    const calls = stubFetch(() => ({ status: 200, json: enrollChallengeFixture() }));
    const challenge = await beginLayerChange('token', FIXTURE_MULTISIG, { type: 'passkey.add', label: 'Phone' });
    assert.equal(challenge.class, 'loosen');
    assert.deepEqual(calls[0], { path: '/solana/layers/enroll/begin', body: { multisig: FIXTURE_MULTISIG, op: { type: 'passkey.add', label: 'Phone' } } });
    stubFetch(() => ({ status: 200, json: enrollChallengeFixture() }));
    await assert.rejects(beginLayerChange('token', FIXTURE_MULTISIG, { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' }), /unexpected passkey registration/);
    const tampered = enrollChallengeFixture();
    (tampered.webauthn.create as Record<string, unknown>).challenge = 'A'.repeat(43);
    stubFetch(() => ({ status: 200, json: tampered }));
    await assert.rejects(beginLayerChange('token', FIXTURE_MULTISIG, { type: 'passkey.add', label: 'Phone' }), /does not match this action/);
  });

  it('sends a waiver only when one is asked for, and uses the change route for removals', async () => {
    const calls = stubFetch(() => ({ status: 200, json: { ...enrollChallengeFixture(), class: 'recovery', webauthn: { get: null, create: null }, required: [{ id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }], capture: undefined } }));
    await beginLayerChange('token', FIXTURE_MULTISIG, { type: 'geolocation.remove-zone', zoneId: 'zone_q' }, ['geolocation']);
    assert.deepEqual(calls[0], { path: '/solana/layers/change/begin', body: { multisig: FIXTURE_MULTISIG, op: { type: 'geolocation.remove-zone', zoneId: 'zone_q' }, waive: ['geolocation'] } });
  });
});
