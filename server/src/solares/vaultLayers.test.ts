import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GuardianError } from './guardian.js';
import { NO_RELEASE_LIMITS, effectiveReleaseLimits } from './vaultPolicy.js';
import { createChallengeStore, type ChallengeFields } from './layers/challenges.js';
import { cleanLabel, fromBase64Url, randomId, randomToken, toBase64Url, toHex } from './layers/codec.js';
import { DESKTOP_ORIGIN, EXTENSION_ORIGIN, LAYER_ENV, layerServerConfig } from './layers/config.js';
import { DeviceCheckError, importDeviceKey, keyIdOf, parseDevicePayload, verifyDeviceEvidence } from './layers/device.js';
import { bluetoothMatchId, changeDigest, changeDigestText, normaliseOp, releaseDigest, releaseDigestText, webauthnChallenge } from './layers/digest.js';
import { haversineM, zoneCheck } from './layers/geo.js';
import { createLockout } from './layers/lockout.js';
import { cidrContains, cidrFor, maskCidr, normaliseCidr, observeNetwork, parseIp } from './layers/network.js';
import { parseChangeOp, parseWaive } from './layers/ops.js';
import { PasskeyCheckError, creationOptions, requestOptions, verifyAssertion, verifyRegistration } from './layers/passkey.js';
import {
  ChangeNotApplicableError, applyChange, checkDeviceBinding, describeLayers, effectiveConfig, emptyLayerConfig, enabledLayers, evaluateLayers, limitsFromChange, planChange, requirementList,
  type DeviceOutcome, type EvaluationChallenge, type PasskeyOutcome,
} from './layers/policy.js';
import { validLayerConfig } from './layers/schema.js';
import { createTestAuthenticator, createTestDevice, type TestDevice } from './layers/testAuthenticator.js';
import {
  RECOVERY_DELAY_MS,
  type ActivationState, type ChangeOp, type DevicePayloadV1, type OptionalLayerId, type PasskeyCredentialRecord, type PendingChange, type SafeZoneRecord, type Surface, type VaultLayerConfig,
} from './layers/types.js';

const AT = Date.parse('2026-10-13T10:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const MULTISIG = '7YsFHZRQ5bVFBWWj1NpbuprEt4EJ5JSEuMEAzZx2iWXp';
const settings = layerServerConfig({});
const web = createTestAuthenticator({ rpId: 'localhost', origin: 'http://localhost:1420' });

function base(over: Partial<VaultLayerConfig> = {}): VaultLayerConfig {
  return { ...emptyLayerConfig(randomToken(32), iso(AT)), version: 1, ...over };
}
function passkeyRecord(id = toBase64Url(new Uint8Array(16).fill(7)), surface: Surface = 'web'): PasskeyCredentialRecord {
  return {
    id, publicKey: toBase64Url(new Uint8Array(77).fill(1)), counter: 0, rpId: 'localhost', transports: ['internal'], deviceType: 'singleDevice', backedUp: false,
    aaguid: '00000000-0000-0000-0000-000000000000', surface, label: 'Laptop', addedAt: iso(AT),
  };
}
const zone = (over: Partial<SafeZoneRecord> = {}): SafeZoneRecord => ({ id: randomId('zone'), label: 'Home', lat: 48.8566, lng: 2.3522, radiusM: 1000, addedAt: iso(AT), ...over });
const challengeOf = (purpose: 'release' | 'change' = 'release'): EvaluationChallenge & { nonce: Uint8Array; digest: Uint8Array } =>
  ({ id: toBase64Url(new Uint8Array(16).fill(9)), nonce: new Uint8Array(32).fill(3), digest: new Uint8Array(32).fill(4), purpose, issuedAt: AT });
function devicePayload(challenge: EvaluationChallenge, device: TestDevice, extra: Partial<DevicePayloadV1> = {}): DevicePayloadV1 {
  return { v: 1, purpose: challenge.purpose, challengeId: challenge.id, nonce: toBase64Url(challenge.nonce), digest: toHex(challenge.digest), keyId: device.keyId, surface: device.surface, signedAt: AT, ...extra };
}
function deviceOutcome(device: TestDevice, payload: DevicePayloadV1 | Record<string, unknown>): DeviceOutcome {
  try { return { ok: true, payload: verifyDeviceEvidence(device.evidence(payload), device), key: device }; }
  catch (error) { return { ok: false, reason: (error as Error).message }; }
}
/** How long a loosening waited before 2026-10-13; only documents stored back then can carry such a pending change. */
const LEGACY_LOOSEN_MS = 24 * 60 * 60 * 1000;

describe('layer binding digests (pinned vectors for the client fixtures)', () => {
  const release = {
    cluster: 'mainnet-beta' as const, multisig: MULTISIG, vault: 'DxRwyQ5Pv4iWG9XyCWeQEQXqYB7UUhBnu9JxrCmzA2TP', transactionIndex: '12',
    transactionData: Uint8Array.from({ length: 10 }, (_, i) => i), asset: 'SOL' as const, amountRaw: '250000000',
    recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', destination: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  };
  it('pins the release digest text and hash', () => {
    assert.equal(releaseDigestText(release), [
      'ANTARA release v1', 'cluster=mainnet-beta', `multisig=${MULTISIG}`, 'vault=DxRwyQ5Pv4iWG9XyCWeQEQXqYB7UUhBnu9JxrCmzA2TP', 'transactionIndex=12',
      'transaction=1f825aa2f0020ef7cf91dfa30da4668d791c5d4824fc8e41354b89ec05795ab3', 'asset=SOL', 'amountRaw=250000000',
      'recipient=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'destination=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    ].join('\n'));
    assert.equal(toHex(releaseDigest(release)), '74ccc723eef0c8588b992f18678cc0fa88804e9844498796ed61bc9cf501a6e9');
    // Any field change gives another digest.
    for (const change of [{ amountRaw: '250000001' }, { transactionIndex: '13' }, { recipient: MULTISIG }, { transactionData: new Uint8Array(10) }, { cluster: 'devnet' as const }]) {
      assert.notEqual(toHex(releaseDigest({ ...release, ...change })), '74ccc723eef0c8588b992f18678cc0fa88804e9844498796ed61bc9cf501a6e9');
    }
  });
  it('pins the change digest, with ops normalised to the §8.1 key order and waivers sorted', () => {
    const op = { center: 'current', radiusM: 250, label: 'Home', type: 'geolocation.add-zone' } as unknown as ChangeOp;
    const input = { multisig: MULTISIG, configVersion: 7, op, waived: ['wifi', 'bluetooth'] as OptionalLayerId[] };
    assert.equal(changeDigestText(input), [
      'ANTARA layer change v1', `multisig=${MULTISIG}`, 'configVersion=7', 'op={"type":"geolocation.add-zone","label":"Home","radiusM":250,"center":"current"}', 'waive=bluetooth,wifi',
    ].join('\n'));
    assert.equal(toHex(changeDigest(input)), '336c5631572447bb7e6c5d5c045f2b102f405ddfd3177e46c731ba6c6588e457');
    assert.deepEqual(Object.keys(normaliseOp({ perDayRaw: { USDC: '2', SOL: '1' }, perReleaseRaw: { SOL: '1', USDC: '1' }, type: 'limits.set' } as unknown as ChangeOp)), ['type', 'perReleaseRaw', 'perDayRaw']);
    assert.notEqual(toHex(changeDigest({ ...input, configVersion: 8 })), toHex(changeDigest(input)));
  });
  it('pins both WebAuthn challenges and keeps them distinct', () => {
    const nonce = new Uint8Array(32).fill(1), digest = new Uint8Array(32).fill(2);
    assert.equal(webauthnChallenge('get', nonce, digest), 'f3G_fSzR32LAGItaCIgePLVMG5dMtaa-VEa5PGlBEA0');
    assert.equal(webauthnChallenge('create', nonce, digest), 'HdKdRuFvyLLkhui462nLL00ZAwJ3OcPbKF6hATiKb4A');
    assert.throws(() => webauthnChallenge('get', new Uint8Array(31), digest));
  });
  it('pins the opaque Desktop Bluetooth match id, bound to the challenge nonce', () => {
    const nonce = new Uint8Array(32).fill(1);
    assert.equal(bluetoothMatchId(nonce, '001A7DDA7113'), 'A81499E93C60');
    assert.notEqual(bluetoothMatchId(new Uint8Array(32).fill(2), '001A7DDA7113'), 'A81499E93C60', 'another challenge gives another id');
    assert.match(bluetoothMatchId(nonce, '001A7DDA7114'), /^[0-9A-F]{12}$/);
    assert.throws(() => bluetoothMatchId(new Uint8Array(31), '001A7DDA7113'));
  });
});

describe('layer challenges and lockout', () => {
  const fields = (privyUserId = 'did:privy:alice'): ChallengeFields => ({
    privyUserId, sessionId: 'session-1', multisig: MULTISIG, purpose: 'release', transactionIndex: '1', digest: new Uint8Array(32), configVersion: 1, required: ['biometrics'], ip: null,
  });
  it('is single use, expires at the TTL and refuses malformed ids', () => {
    let clock = AT;
    const store = createChallengeStore({ now: () => clock });
    const first = store.issue(fields());
    assert.equal(first.nonce.length, 32); assert.equal(first.expiresAt - first.issuedAt, 5 * 60 * 1000); assert.match(first.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(store.take(first.id)?.id, first.id);
    assert.equal(store.take(first.id), null, 'a second take returns null');
    const second = store.issue(fields());
    clock += 5 * 60 * 1000 - 1;
    const third = store.issue(fields());
    assert.equal(store.take(second.id)?.id, second.id, 'still valid just before the TTL');
    clock += 1;
    assert.equal(store.take(third.id)?.id, third.id);
    const expiring = store.issue(fields());
    clock += 5 * 60 * 1000;
    assert.equal(store.take(expiring.id), null, 'expired at the TTL');
    for (const id of [undefined, 42, '', 'short', 'x'.repeat(23), first.id + '=']) assert.equal(store.take(id), null);
  });
  it('caps open challenges per user and in total, evicting the oldest', () => {
    const store = createChallengeStore({ now: () => AT, perUser: 3, total: 5 });
    const alice = [1, 2, 3, 4].map(() => store.issue(fields()));
    assert.equal(store.take(alice[0].id), null, 'the oldest of the user is evicted');
    const bob = [1, 2, 3].map(() => store.issue(fields('did:privy:bob')));
    assert.equal(store.size, 5);
    assert.equal(store.take(alice[1].id), null, 'the oldest overall is evicted at the global cap');
    assert.ok(store.take(bob[2].id)); assert.ok(store.take(alice[3].id));
  });
  it('locks a vault after 5 failures in 15 minutes, for 15 minutes', () => {
    let clock = AT;
    const lockout = createLockout({ now: () => clock });
    for (let i = 0; i < 4; i++) assert.equal(lockout.fail('vault').locked, false);
    clock += 15 * 60 * 1000;
    assert.equal(lockout.fail('vault').locked, false, 'failures outside the window do not count');
    for (let i = 0; i < 3; i++) lockout.fail('vault');
    const locked = lockout.fail('vault');
    assert.deepEqual(locked, { locked: true, retryAfterSeconds: 900 });
    assert.equal(lockout.check('other').locked, false);
    clock += 15 * 60 * 1000 - 1000;
    assert.equal(lockout.check('vault').locked, true);
    clock += 1000;
    assert.equal(lockout.check('vault').locked, false);
  });
});

describe('Biometrics layer: passkeys verified by ANTARA', () => {
  const challenge = challengeOf();
  const get = webauthnChallenge('get', challenge.nonce, challenge.digest);
  const create = webauthnChallenge('create', challenge.nonce, challenge.digest);
  async function enrolled(options: { counter?: number; origin?: string } = {}) {
    const { response, passkey } = (options.origin ? createTestAuthenticator({ rpId: 'localhost', origin: options.origin }) : web).register({ challenge: create, counter: options.counter });
    const verified = await verifyRegistration({ response, expectedChallenge: create, config: settings });
    return { passkey, record: { ...verified, label: 'Laptop', addedAt: iso(AT) } satisfies PasskeyCredentialRecord };
  }
  it('registers with user verification and verifies an assertion bound to the exact challenge', async () => {
    const { passkey, record } = await enrolled({ counter: 5 });
    assert.equal(record.surface, 'web'); assert.equal(record.rpId, 'localhost'); assert.equal(record.counter, 5);
    const facts = await verifyAssertion({ response: web.assert(passkey, { challenge: get }), credentials: [record], expectedChallenge: get, config: settings });
    assert.deepEqual({ ...facts }, { credentialId: record.id, newCounter: 6, surface: 'web', deviceType: 'singleDevice', backedUp: false });
    const desktop = await enrolled({ origin: DESKTOP_ORIGIN });
    assert.equal(desktop.record.surface, 'desktop');
    const extension = await enrolled({ origin: EXTENSION_ORIGIN });
    assert.equal(extension.record.surface, 'extension');
  });
  it('refuses user verification off, a wrong origin, a wrong RP ID and wrong challenges', async () => {
    const { passkey, record } = await enrolled();
    const refused = async (response: unknown, expectedChallenge = get, credentials = [record]) =>
      assert.rejects(verifyAssertion({ response, credentials, expectedChallenge, config: settings }), PasskeyCheckError);
    await refused(web.assert(passkey, { challenge: get, uv: false }));
    await refused(web.assert(passkey, { challenge: get, origin: 'https://evil.example' }));
    await refused(web.assert(passkey, { challenge: get, rpId: 'example.com' }));
    await refused(web.assert(passkey, { challenge: webauthnChallenge('get', challenge.nonce, new Uint8Array(32).fill(5)) }), 'another digest');
    await refused(web.assert(passkey, { challenge: create }), get);
    await refused(web.assert(passkey, { challenge: get, type: 'webauthn.create' }));
    await refused({ ...web.assert(passkey, { challenge: get }), extra: true });
    // A registration with UV off, or made for the get challenge, is refused.
    await assert.rejects(verifyRegistration({ response: web.register({ challenge: create, uv: false }).response, expectedChallenge: create, config: settings }), /did not verify you|could not be verified/);
    await assert.rejects(verifyRegistration({ response: web.register({ challenge: get }).response, expectedChallenge: create, config: settings }), PasskeyCheckError);
  });
  it('refuses a ceremony run inside another site’s frame (crossOrigin or topOrigin), which the library does not check', async () => {
    const { passkey, record } = await enrolled();
    const framed = (options: { crossOrigin?: boolean; topOrigin?: string }) =>
      assert.rejects(verifyAssertion({ response: web.assert(passkey, { challenge: get, ...options }), credentials: [record], expectedChallenge: get, config: settings }), /not inside another site/);
    await framed({ crossOrigin: true });
    await framed({ topOrigin: 'https://evil.example' });
    await framed({ crossOrigin: false, topOrigin: 'http://localhost:1420' });
    for (const options of [{ crossOrigin: true }, { topOrigin: 'https://evil.example' }]) {
      await assert.rejects(verifyRegistration({ response: web.register({ challenge: create, ...options }).response, expectedChallenge: create, config: settings }), /not inside another site/);
    }
    // clientDataJSON that is not JSON is refused before the library sees it.
    const broken = web.assert(passkey, { challenge: get });
    await assert.rejects(verifyAssertion({ response: { ...broken, response: { ...broken.response, clientDataJSON: toBase64Url(new TextEncoder().encode('{not json')) } }, credentials: [record], expectedChallenge: get, config: settings }), PasskeyCheckError);
    // A top-level ceremony (crossOrigin false, no topOrigin) still verifies.
    assert.equal((await verifyAssertion({ response: web.assert(passkey, { challenge: get }), credentials: [record], expectedChallenge: get, config: settings })).credentialId, record.id);
  });
  it('refuses counter regression, unknown or pending credentials and a record from another RP ID', async () => {
    const { passkey, record } = await enrolled({ counter: 10 });
    const stored = { ...record, counter: 20 };
    await assert.rejects(verifyAssertion({ response: web.assert(passkey, { challenge: get }), credentials: [stored], expectedChallenge: get, config: settings }), PasskeyCheckError);
    const other = await enrolled();
    // Only active credentials are passed in; a pending addition is not among them.
    await assert.rejects(verifyAssertion({ response: web.assert(other.passkey, { challenge: get }), credentials: [record], expectedChallenge: get, config: settings }), /not an active passkey/);
    await assert.rejects(verifyAssertion({ response: web.assert(passkey, { challenge: get }), credentials: [{ ...record, rpId: 'antara.tech' }], expectedChallenge: get, config: settings }), /different ANTARA domain/);
  });
  it('builds request and creation options with UV required, hybrid allowed and every active credential', () => {
    const record = passkeyRecord();
    assert.deepEqual(requestOptions(settings, [record], get), { challenge: get, rpId: 'localhost', allowCredentials: [{ id: record.id, type: 'public-key', transports: ['internal'] }], userVerification: 'required', timeout: 120000 });
    const options = creationOptions({ config: settings, webauthnUserId: randomToken(32), multisig: MULTISIG, challenge: create, exclude: [record] });
    assert.deepEqual(options.authenticatorSelection, { residentKey: 'preferred', userVerification: 'required' });
    assert.equal(options.attestation, 'none'); assert.equal(options.user.name, 'ANTARA vault 7YsFHZ…iWXp');
    assert.deepEqual(options.pubKeyCredParams.map(item => item.alg), [-7, -257]);
  });
  it('reads server-only passkey settings and fails closed (503) on invalid values, naming only the variable', () => {
    assert.deepEqual(layerServerConfig({ NODE_ENV: 'production' }).origins, ['https://antara.tech', DESKTOP_ORIGIN, EXTENSION_ORIGIN]);
    assert.equal(layerServerConfig({ NODE_ENV: 'production' }).rpId, 'antara.tech');
    for (const env of [{ [LAYER_ENV.rpId]: 'https://antara.tech' }, { [LAYER_ENV.rpId]: '10.0.0.1' }, { [LAYER_ENV.origins]: 'http://antara.tech', NODE_ENV: 'production' }, { [LAYER_ENV.origins]: 'https://a.example/path' }]) {
      assert.throws(() => layerServerConfig(env), (error: unknown) => error instanceof GuardianError && error.status === 503 && !Object.values(env).some(value => value !== 'production' && error.message.includes(value)));
    }
    assert.equal(settings.surfaceForOrigin('https://evil.example'), null);
  });
});

describe('trusted devices and device-reported readings', () => {
  const challenge = challengeOf();
  const desktop = createTestDevice('desktop');
  it('verifies the signature over the exact bytes before a strict parse', () => {
    const good = deviceOutcome(desktop, devicePayload(challenge, desktop, { geo: { lat: 1, lng: 2, accuracyM: 30, at: AT, source: 'windows-location' } }));
    assert.equal(good?.ok, true);
    assert.equal(keyIdOf(importDeviceKey(desktop.publicKeySpki).spki), desktop.keyId);
    const evidence = desktop.evidence(devicePayload(challenge, desktop));
    const flipped = Buffer.from(evidence.payload, 'base64url'); flipped[10] ^= 1;
    assert.throws(() => verifyDeviceEvidence({ ...evidence, payload: flipped.toString('base64url') }, desktop), /does not verify/);
    assert.throws(() => verifyDeviceEvidence({ ...evidence, signature: toBase64Url(new Uint8Array(64)) }, desktop), /does not verify/);
    assert.throws(() => verifyDeviceEvidence({ ...evidence, extra: 1 }, desktop), /malformed/);
    assert.throws(() => verifyDeviceEvidence(evidence, createTestDevice('desktop')), /isn't trusted/);
    assert.throws(() => verifyDeviceEvidence(desktop.evidence({}, { bytes: new Uint8Array(4097).fill(32) }), desktop), /too large/);
  });
  it('refuses P-384 and RSA device keys', () => {
    for (const kind of ['p384', 'rsa'] as const) assert.throws(() => importDeviceKey(createTestDevice('web', kind).publicKeySpki), DeviceCheckError);
  });
  it('refuses unknown fields, non-finite numbers and malformed readings', () => {
    const parse = (value: unknown, raw?: string) => () => parseDevicePayload(new TextEncoder().encode(raw ?? JSON.stringify(value)));
    const payload = devicePayload(challenge, desktop);
    assert.doesNotThrow(parse(payload));
    assert.throws(parse({ ...payload, extra: true }), DeviceCheckError);
    assert.throws(parse({ ...payload, geo: { lat: 1, lng: 2, accuracyM: 30, at: AT, source: 'windows-location', altitude: 3 } }), DeviceCheckError);
    assert.throws(parse(null, JSON.stringify({ ...payload, geo: { lat: 1, lng: 2, accuracyM: 30, at: AT, source: 'windows-location' } }).replace('"accuracyM":30', '"accuracyM":1e999')), DeviceCheckError, 'Infinity');
    assert.throws(parse(null, JSON.stringify(payload).replace(`"signedAt":${AT}`, '"signedAt":NaN')), DeviceCheckError, 'NaN');
    assert.throws(parse({ ...payload, wifi: { connections: [{ ssidHex: '486f6d65', bssid: 'aa:bb:cc:dd:ee:ff' }], at: AT, source: 'windows-wlan' } }), DeviceCheckError, 'lowercase BSSID');
    assert.throws(parse({ ...payload, bluetooth: { devices: [{ identifier: '001a7dda7113', name: 'x' }], at: AT, source: 'windows-classic' } }), DeviceCheckError);
    assert.throws(parse({ ...payload, v: 2 }), DeviceCheckError);
  });
  it('binds a reading to the exact challenge, key, surface and time window', () => {
    const bound = (extra: Partial<DevicePayloadV1>) => checkDeviceBinding(deviceOutcome(desktop, devicePayload(challenge, desktop, extra)), challenge, AT);
    assert.equal(bound({}).ok, true);
    for (const extra of [
      { nonce: toBase64Url(new Uint8Array(32)) }, { digest: toHex(new Uint8Array(32)) }, { purpose: 'change' as const }, { challengeId: toBase64Url(new Uint8Array(16)) },
      { surface: 'web' as const }, { keyId: createTestDevice('desktop').keyId }, { signedAt: AT - 121_000 }, { signedAt: AT + 121_000 },
      { geo: { lat: 1, lng: 2, accuracyM: 30, at: AT - 200_000, source: 'windows-location' as const } },
    ]) assert.equal(bound(extra).ok, false, JSON.stringify(extra));
    assert.equal(bound({ signedAt: AT - 119_000 }).ok, true, 'clock skew within 120 s');
    assert.equal(checkDeviceBinding(null, challenge, AT).ok, false);
  });
});

describe('Safe Zones layer', () => {
  const home = zone({ radiusM: 1000 });
  it('passes inside a zone only when the accuracy fits', () => {
    assert.deepEqual(zoneCheck({ lat: home.lat, lng: home.lng, accuracyM: 30 }, [home]), { ok: true });
    assert.equal(zoneCheck({ lat: home.lat, lng: home.lng, accuracyM: 500 }, [home]).ok, true, 'accuracy exactly radius/2');
    assert.equal(zoneCheck({ lat: home.lat, lng: home.lng, accuracyM: 500.01 }, [home]).ok, false, 'accuracy above radius/2');
    // 0.0046 degrees of latitude is about 511 m: with 500 m accuracy the reading could lie beyond the radius.
    assert.equal(zoneCheck({ lat: home.lat + 0.0046, lng: home.lng, accuracyM: 500 }, [home]).ok, false, 'distance + accuracy beyond the radius');
    assert.equal(zoneCheck({ lat: home.lat + 0.0046, lng: home.lng, accuracyM: 100 }, [home]).ok, true);
    assert.match((zoneCheck({ lat: home.lat + 1, lng: home.lng, accuracyM: 10 }, [home]) as { reason: string }).reason, /outside your safe zones/);
  });
  it('denies zero, missing or non-finite accuracy and invalid coordinates', () => {
    for (const reading of [{ lat: home.lat, lng: home.lng, accuracyM: 0 }, { lat: home.lat, lng: home.lng, accuracyM: NaN }, { lat: home.lat, lng: home.lng, accuracyM: undefined },
      { lat: home.lat, lng: home.lng, accuracyM: -5 }, { lat: NaN, lng: home.lng, accuracyM: 10 }, { lat: 91, lng: 0, accuracyM: 10 }, { lat: 0, lng: Infinity, accuracyM: 10 }, null]) {
      assert.equal(zoneCheck(reading, [home]).ok, false, JSON.stringify(reading));
    }
    assert.equal(zoneCheck({ lat: home.lat, lng: home.lng, accuracyM: 10 }, []).ok, false, 'no zone');
  });
  it('handles the antimeridian, the poles and several zones, never revealing a center or distance', () => {
    const fiji = zone({ lat: -17, lng: 179.999, radiusM: 1000 });
    assert.equal(zoneCheck({ lat: -17, lng: -179.999, accuracyM: 20 }, [fiji]).ok, true, 'across the antimeridian (about 213 m)');
    assert.ok(Math.abs(haversineM({ lat: 90, lng: 0 }, { lat: 90, lng: 120 })) < 1e-6, 'all longitudes meet at the pole');
    assert.equal(zoneCheck({ lat: 89.999, lng: -45, accuracyM: 20 }, [zone({ lat: 90, lng: 0, radiusM: 500 })]).ok, true);
    const work = zone({ lat: 40.7128, lng: -74.006, radiusM: 200 });
    assert.equal(zoneCheck({ lat: 40.7128, lng: -74.006, accuracyM: 50 }, [home, work]).ok, true);
    const denial = zoneCheck({ lat: 0, lng: 0, accuracyM: 50 }, [home, work]) as { ok: false; reason: string };
    assert.doesNotMatch(denial.reason, /\d/);
    assert.equal(Number.isNaN(haversineM({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })), true);
  });
});

describe('Wi-Fi layer: trusted network (server-observed)', () => {
  it('normalises CIDRs within the bounds and refuses non-public ranges', () => {
    assert.equal(normaliseCidr('203.0.113.7'), '203.0.113.7/32');
    assert.equal(normaliseCidr('203.0.113.7/24'), '203.0.113.0/24');
    assert.equal(normaliseCidr('2a01:4f8:c0c:1234:5678::1'), '2a01:4f8:c0c:1234::/64');
    assert.equal(normaliseCidr('2A01:4F8:C0C::/48'), '2a01:4f8:c0c::/48');
    for (const value of ['203.0.113.7/23', '2a01:4f8::/47', '10.0.0.1', '192.168.1.1/32', '172.16.0.1', '100.64.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '0.0.0.0', '224.0.0.1', '1.2.3', 'x', '1.2.3.4/33', '1.2.3.4/24/1', 42]) {
      assert.equal(normaliseCidr(value), null, String(value));
    }
  });
  it('matches IPv4, IPv6 and IPv4-mapped addresses against enrolled prefixes', () => {
    assert.equal(cidrContains('203.0.113.0/24', parseIp('203.0.113.200')!), true);
    assert.equal(cidrContains('203.0.113.0/24', parseIp('203.0.114.1')!), false);
    assert.equal(cidrContains('203.0.113.7/32', parseIp('::ffff:203.0.113.7')!), true, 'IPv4-mapped IPv6 is normalised');
    assert.equal(cidrContains('2a01:4f8:c0c:1234::/64', parseIp('2a01:4f8:c0c:1234:ffff::9')!), true);
    assert.equal(cidrContains('2a01:4f8:c0c:1234::/64', parseIp('2a01:4f8:c0c:1235::9')!), false);
    assert.equal(cidrContains('203.0.113.0/24', parseIp('2a01:4f8::1')!), false, 'families never match');
    assert.equal(cidrFor(parseIp('203.0.113.7')!, 64), null);
    assert.equal(maskCidr('203.0.113.0/24'), 'IPv4 203.0.x.x/24');
    assert.equal(maskCidr('2a01:4f8:c0c:1234::/64'), 'IPv6 2a01:4f8:c0c:…/64');
  });
  it('observes only a public address, and nothing in production without TRUST_PROXY', () => {
    assert.equal(observeNetwork('203.0.113.7', { production: true, trustProxy: false }).status, 'unconfigured');
    assert.equal(observeNetwork('203.0.113.7', { production: true, trustProxy: 1 }).status, 'public');
    for (const ip of ['10.1.2.3', '127.0.0.1', '::1', '::ffff:192.168.0.1', '100.64.0.1', undefined, null, 'garbage']) {
      assert.equal(observeNetwork(ip, { production: false, trustProxy: false }).status, 'not-public', String(ip));
    }
  });
});

describe('change parsing and classification (docs/VAULT_LAYERS.md §8.1)', () => {
  const device = createTestDevice('desktop');
  const credential = passkeyRecord();
  const second = passkeyRecord(toBase64Url(new Uint8Array(16).fill(8)));
  const bt = { id: randomId('bt'), label: 'Phone', surface: 'desktop' as const, source: 'windows-classic' as const, identifier: '001A7DDA7113', name: 'Pixel 9', addedAt: iso(AT) };
  const net = { id: randomId('net'), label: 'Home', cidr: '203.0.113.0/24', addedAt: iso(AT) };
  const radio = { id: randomId('radio'), label: 'Home Wi-Fi', ssid: 'Home', ssidHex: '486f6d65', bssids: ['AA:BB:CC:DD:EE:FF'], addedAt: iso(AT) };
  const plan = (config: VaultLayerConfig | null, op: ChangeOp, waived: OptionalLayerId[] = [], activation?: ActivationState) =>
    planChange({ config, op, waived, ...(activation ? { activation } : {}) });
  const limitsSet = (perReleaseRaw: { SOL: string | null; USDC: string | null }, perDayRaw: { SOL: string | null; USDC: string | null }): ChangeOp => ({ type: 'limits.set', perReleaseRaw, perDayRaw });
  /** A vault with its passkey and every other layer off. */
  const withPasskey = (over: Partial<VaultLayerConfig> = {}) => base({ biometrics: { credentials: [credential] }, ...over });
  const off = withPasskey();
  const on = base({ biometrics: { credentials: [credential, second] }, geolocation: { zones: [zone(), zone()] }, wifi: { mode: 'network+radio', networks: [net, { ...net, id: randomId('net'), cidr: '198.51.100.0/24' }], radios: [radio, { ...radio, id: randomId('radio'), ssidHex: '576f726b' }] }, bluetooth: { devices: [bt, { ...bt, id: randomId('bt'), identifier: '001A7DDA7114' }] }, devices: [{ keyId: device.keyId, publicKeySpki: device.publicKeySpki, surface: 'desktop', label: 'PC', addedAt: iso(AT) }] });
  const single = base({ biometrics: { credentials: [credential] }, geolocation: { zones: [on.geolocation!.zones[0]] }, wifi: { mode: 'network+radio', networks: [net], radios: [radio] }, bluetooth: { devices: [bt] } });
  const cls = (config: VaultLayerConfig | null, op: ChangeOp) => plan(config, op).class;

  it('classifies every op, row by row', () => {
    const rows: Array<[string, VaultLayerConfig | null, ChangeOp, 'tighten' | 'loosen']> = [
      ['passkey.add, Biometrics on', on, { type: 'passkey.add', label: 'Key' }, 'loosen'],
      ['passkey.remove, not the last', on, { type: 'passkey.remove', credentialId: credential.id }, 'tighten'],
      ['device.add, no device-reported layer', base({ biometrics: { credentials: [credential] } }), { type: 'device.add', label: 'PC', surface: 'web', publicKeySpki: createTestDevice('web').publicKeySpki }, 'tighten'],
      ['device.add, a device-reported layer on', on, { type: 'device.add', label: 'PC', surface: 'desktop', publicKeySpki: createTestDevice('desktop').publicKeySpki }, 'loosen'],
      ['device.remove', on, { type: 'device.remove', keyId: device.keyId }, 'tighten'],
      ['geolocation.add-zone, off', off, { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' }, 'tighten'],
      ['geolocation.add-zone, on', on, { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: { lat: 1, lng: 2 } }, 'loosen'],
      ['geolocation.remove-zone, not the last', on, { type: 'geolocation.remove-zone', zoneId: on.geolocation!.zones[0].id }, 'tighten'],
      ['geolocation.remove-zone, the last', single, { type: 'geolocation.remove-zone', zoneId: single.geolocation!.zones[0].id }, 'loosen'],
      ['wifi.add-network, off', off, { type: 'wifi.add-network', label: 'Home' }, 'tighten'],
      ['wifi.add-network, on', on, { type: 'wifi.add-network', label: 'Office', cidr: '192.0.2.0/24' }, 'loosen'],
      ['wifi.remove-network, not the last', on, { type: 'wifi.remove-network', networkId: net.id }, 'tighten'],
      ['wifi.remove-network, the last', single, { type: 'wifi.remove-network', networkId: net.id }, 'loosen'],
      ['wifi.add-radio, network mode without radios', withPasskey({ wifi: { mode: 'network', networks: [net], radios: [] } }), { type: 'wifi.add-radio', label: 'Home' }, 'tighten'],
      ['wifi.add-radio, otherwise', single, { type: 'wifi.add-radio', label: 'Office' }, 'loosen'],
      ['wifi.add-bssid', single, { type: 'wifi.add-bssid', radioId: radio.id }, 'loosen'],
      ['wifi.remove-radio, not the last', on, { type: 'wifi.remove-radio', radioId: radio.id }, 'tighten'],
      ['wifi.remove-radio, last in network+radio mode', single, { type: 'wifi.remove-radio', radioId: radio.id }, 'loosen'],
      ['wifi.remove-radio, network mode', withPasskey({ wifi: { mode: 'network', networks: [net], radios: [radio] } }), { type: 'wifi.remove-radio', radioId: radio.id }, 'tighten'],
      ['wifi.set-mode to network+radio', withPasskey({ wifi: { mode: 'network', networks: [net], radios: [radio] } }), { type: 'wifi.set-mode', mode: 'network+radio' }, 'tighten'],
      ['wifi.set-mode to network', single, { type: 'wifi.set-mode', mode: 'network' }, 'loosen'],
      ['bluetooth.add-device, off', off, { type: 'bluetooth.add-device', label: 'Phone' }, 'tighten'],
      ['bluetooth.add-device, on', on, { type: 'bluetooth.add-device', label: 'Watch' }, 'loosen'],
      ['bluetooth.remove-device, not the last', on, { type: 'bluetooth.remove-device', deviceId: bt.id }, 'tighten'],
      ['bluetooth.remove-device, the last', single, { type: 'bluetooth.remove-device', deviceId: bt.id }, 'loosen'],
      ['limits.set, first caps (Limits off)', off, limitsSet({ SOL: '100000000', USDC: null }, { SOL: null, USDC: '100000000' }), 'tighten'],
      ['limits.set, any size (no server ceiling)', off, limitsSet({ SOL: '9'.repeat(30), USDC: '9'.repeat(30) }, { SOL: null, USDC: null }), 'tighten'],
      ['layer.disable', on, { type: 'layer.disable', layer: 'geolocation' }, 'loosen'],
    ];
    for (const [name, config, op, expected] of rows) assert.equal(cls(config, op), expected, name);
    // Owner decision 2026-10-13: loosening applies at once (no 24-hour wait), but still needs every layer that is on.
    for (const [, config, op, expected] of rows) {
      const result = plan(config, op);
      assert.equal(result.delayMs, null, `${op.type} applies immediately`);
      if (expected === 'loosen') assert.deepEqual(result.required, enabledLayers(config), `${op.type} needs every layer that is on`);
    }
    const capped = withPasskey({ limits: { perReleaseRaw: { SOL: '100000000', USDC: null }, perDayRaw: { SOL: '1000000000', USDC: null } } });
    const raised = plan(capped, limitsSet({ SOL: '500000000', USDC: null }, { SOL: '1000000000', USDC: null }));
    assert.deepEqual([raised.class, raised.delayMs, raised.required], ['loosen', null, ['biometrics']], 'raising a cap loosens, at once');
    assert.equal(plan(capped, limitsSet({ SOL: '100000000', USDC: null }, { SOL: null, USDC: null })).class, 'loosen', 'removing a cap loosens');
    assert.equal(plan(capped, limitsSet({ SOL: '50000000', USDC: '1' }, { SOL: '1000000000', USDC: null })).class, 'tighten', 'lowering a cap or adding one tightens');
    const turnOff = plan(capped, limitsSet({ SOL: null, USDC: null }, { SOL: null, USDC: null }));
    assert.deepEqual([turnOff.class, turnOff.delayMs], ['loosen', null], 'turning Limits off applies at once');
    assert.deepEqual([plan(capped, { type: 'layer.disable', layer: 'limits' }).class, plan(capped, { type: 'layer.disable', layer: 'limits' }).delayMs], ['loosen', null]);
    assert.throws(() => plan(off, { type: 'layer.disable', layer: 'limits' }), /Limits is already off/);
    assert.throws(() => plan(off, limitsSet({ SOL: null, USDC: null }, { SOL: null, USDC: null })), /Limits are already off/);
  });
  it('requires the passkey to tighten and every enabled layer to loosen', () => {
    assert.deepEqual(plan(on, { type: 'device.remove', keyId: device.keyId }).required, ['biometrics']);
    assert.deepEqual(plan(on, { type: 'layer.disable', layer: 'bluetooth' }).required, ['bluetooth', 'wifi', 'biometrics', 'geolocation']);
    assert.equal(plan(on, { type: 'device.remove', keyId: device.keyId }).delayMs, null);
    assert.deepEqual(plan(on, { type: 'device.remove', keyId: device.keyId }).waived, []);
  });
  it('applies a first passkey at once only from the registering session, and allows nothing else before it', () => {
    const first: ChangeOp = { type: 'passkey.add', label: 'First' };
    for (const config of [null, base()]) {
      const activated = plan(config, first, [], 'session');
      assert.deepEqual([activated.class, activated.required, activated.waived, activated.delayMs], ['tighten', [], [], null], 'the registering session, within the window');
      assert.throws(() => plan(config, first, [], 'other-session'), (error: unknown) => error instanceof GuardianError && error.status === 403 && /app that activated it/.test(error.message));
      // Without an open window (it expired, the server restarted, or no activation was recorded): 7 days, waiving Biometrics, visible and cancelable.
      for (const late of [plan(config, first, [], 'none'), plan(config, first)]) {
        assert.deepEqual([late.class, late.required, late.waived, late.delayMs], ['recovery', [], ['biometrics'], RECOVERY_DELAY_MS]);
      }
      assert.throws(() => plan(config, first, ['biometrics'], 'session'), /not on, so it cannot be waived/);
      // Nothing can be pre-positioned for a passkey that does not exist yet, whatever the window.
      for (const op of [
        { type: 'device.add', label: 'PC', surface: 'web', publicKeySpki: createTestDevice('web').publicKeySpki },
        { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: { lat: 1, lng: 2 } }, { type: 'wifi.add-network', label: 'Home', cidr: '203.0.113.0/24' },
        { type: 'bluetooth.add-device', label: 'Phone' }, { type: 'limits.set', perReleaseRaw: { SOL: '100000000', USDC: '10000000' }, perDayRaw: { SOL: '1000000000', USDC: '100000000' } },
        { type: 'layer.disable', layer: 'wifi' },
      ] as ChangeOp[]) {
        for (const activation of ['session', 'none'] as const) {
          assert.throws(() => plan(config, op, [], activation), (error: unknown) => error instanceof GuardianError && error.status === 409 && /Add a passkey to this vault first/.test(error.message), `${op.type} ${activation}`);
        }
      }
    }
    // Once a passkey exists, the window no longer matters: another passkey loosens.
    assert.equal(plan(off, first, [], 'session').class, 'loosen');
    assert.equal(plan(off, first, [], 'other-session').class, 'loosen');
  });
  it('makes removing the last passkey or device not added through recovery a loosening, so a recovery passkey alone cannot evict the owner', () => {
    const owner = passkeyRecord(toBase64Url(new Uint8Array(16).fill(1)));
    const attacker = passkeyRecord(toBase64Url(new Uint8Array(16).fill(2)));
    const ownerDevice = { keyId: device.keyId, publicKeySpki: device.publicKeySpki, surface: 'desktop' as const, label: 'PC', addedAt: iso(AT) };
    const other = createTestDevice('web');
    const attackerDevice = { keyId: other.keyId, publicKeySpki: other.publicKeySpki, surface: 'web' as const, label: 'Browser', addedAt: iso(AT) };
    const requested = withPasskey({ biometrics: { credentials: [owner] }, devices: [ownerDevice], pending: [
      { id: randomId('chg'), op: { type: 'passkey.add', credential: attacker }, class: 'recovery', waived: ['biometrics'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS), requestedFrom: null },
      { id: randomId('chg'), op: { type: 'device.add', device: attackerDevice }, class: 'recovery', waived: ['biometrics'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS + 1), requestedFrom: null },
    ] });
    // Seven days unnoticed: both recovery additions apply and are marked.
    const applied = effectiveConfig(requested, AT + RECOVERY_DELAY_MS + 1).config;
    assert.deepEqual(applied.biometrics!.credentials.map(item => item.addedVia ?? 'original'), ['original', 'recovery']);
    assert.deepEqual(applied.devices.map(item => item.addedVia ?? 'original'), ['original', 'recovery']);
    assert.ok(validLayerConfig(applied));
    // Evicting the owner's passkey or device is a loosening: it needs every enabled layer (no 24-hour wait since 2026-10-13).
    const evictPasskey = plan(applied, { type: 'passkey.remove', credentialId: owner.id });
    assert.deepEqual([evictPasskey.class, evictPasskey.delayMs, evictPasskey.required], ['loosen', null, ['biometrics']]);
    assert.equal(plan(applied, { type: 'device.remove', keyId: ownerDevice.keyId }).class, 'loosen');
    // The owner removes the recovery-added ones at once.
    assert.equal(plan(applied, { type: 'passkey.remove', credentialId: attacker.id }).class, 'tighten');
    assert.equal(plan(applied, { type: 'device.remove', keyId: attackerDevice.keyId }).class, 'tighten');
    // With another original passkey or device left, removal stays immediate; removing the only device is immediate (nothing remains to act with).
    assert.equal(plan({ ...applied, biometrics: { credentials: [...applied.biometrics!.credentials, second] } }, { type: 'passkey.remove', credentialId: owner.id }).class, 'tighten');
    assert.equal(plan({ ...applied, devices: [ownerDevice] }, { type: 'device.remove', keyId: ownerDevice.keyId }).class, 'tighten');
    // A legacy pending loosening (stored before 2026-10-13) applies at once and is not marked.
    const loosened = effectiveConfig(withPasskey({ pending: [{ id: randomId('chg'), op: { type: 'passkey.add', credential: attacker }, class: 'loosen', waived: [], requestedAt: iso(AT), effectiveAt: iso(AT + LEGACY_LOOSEN_MS), requestedFrom: 'web' }] }), AT).config;
    assert.deepEqual(loosened.biometrics!.credentials.map(item => item.addedVia ?? 'original'), ['original', 'original']);
    // The GET view says which passkey came through recovery, pending or applied.
    const view = describeLayers({ config: requested, network: { status: 'not-public' } });
    assert.deepEqual(view.layers[2].items.map(item => [item.state, item.detail]), [
      ['active', 'Device-bound passkey · added from Web'], ['pending-addition', 'Device-bound passkey · added from Web · added through recovery'],
    ]);
    const after = describeLayers({ config: applied, network: { status: 'not-public' } });
    assert.match(after.layers[2].items[1].detail, /added through recovery$/);
    assert.equal(validLayerConfig({ ...applied, devices: [{ ...ownerDevice, addedVia: 'loosen' }] }), false, 'provenance is only ever "recovery"');
  });
  it('says before any ceremony that a new app cannot pass Bluetooth enrolled for another app', () => {
    const webKey = createTestDevice('web').publicKeySpki;
    // Bluetooth is on with a Desktop device only: a browser key cannot pass it, so adding one needs recovery that waives Bluetooth.
    assert.throws(() => plan(on, { type: 'device.add', label: 'Browser', surface: 'web', publicKeySpki: webKey }), /no trusted Bluetooth device is set up for Web/);
    assert.equal(plan(on, { type: 'device.add', label: 'Browser', surface: 'web', publicKeySpki: webKey }, ['bluetooth']).class, 'recovery');
    assert.equal(plan(on, { type: 'device.add', label: 'PC 2', surface: 'desktop', publicKeySpki: createTestDevice('desktop').publicKeySpki }).class, 'loosen');
  });
  it('never turns Biometrics off or removes the last passkey (owner decision)', () => {
    assert.throws(() => plan(on, { type: 'layer.disable', layer: 'biometrics' }), (error: unknown) => error instanceof GuardianError && error.status === 403);
    assert.throws(() => plan(single, { type: 'passkey.remove', credentialId: credential.id }), /required for every vault release/);
    assert.throws(() => plan(single, { type: 'passkey.remove', credentialId: credential.id }, ['biometrics']), /required for every vault release/, 'not even in recovery');
    const removing: PendingChange = { id: randomId('chg'), op: { type: 'passkey.remove', credentialId: second.id }, class: 'recovery', waived: ['biometrics'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS), requestedFrom: 'web' };
    assert.throws(() => plan({ ...on, pending: [removing] }, { type: 'passkey.remove', credentialId: credential.id }, ['biometrics']), /required for every vault release/, 'counting pending removals');
    assert.throws(() => applyChange(single, { type: 'passkey.remove', credentialId: credential.id }), ChangeNotApplicableError);
    assert.throws(() => applyChange(on, { type: 'layer.disable', layer: 'biometrics' }), ChangeNotApplicableError);
  });
  it('applies waivers as 7-day recovery (the lost-device path), and never waives Limits or a layer that is off', () => {
    const recovery = plan(on, { type: 'passkey.add', label: 'New phone' }, ['biometrics']);
    assert.equal(recovery.class, 'recovery'); assert.equal(recovery.delayMs, RECOVERY_DELAY_MS);
    assert.deepEqual(recovery.required, ['bluetooth', 'wifi', 'geolocation']);
    assert.deepEqual(parseWaive(['wifi', 'biometrics']), ['biometrics', 'wifi']);
    assert.deepEqual(parseWaive(undefined), []);
    for (const value of [['limits'], ['wifi', 'wifi'], ['voice'], 'wifi', [1]]) assert.throws(() => parseWaive(value), GuardianError, JSON.stringify(value));
    assert.throws(() => parseWaive(['limits']), /Limits needs no recovery/);
    // The vault authenticator is optional (owner decision 2026-10-13): a lost phone is a 7-day recovery.
    assert.deepEqual(parseWaive(['mfa', 'wifi']), ['mfa', 'wifi']);
    assert.throws(() => plan(off, { type: 'passkey.add', label: 'Key' }, ['geolocation']), /not on, so it cannot be waived/);
  });
  it('enforces item counts, the 5-pending recovery limit, pending conflicts and limit consistency', () => {
    const pendingAdd = (n: number): PendingChange => ({ id: randomId('chg'), op: { type: 'geolocation.add-zone', zone: zone({ label: `Place ${n}` }) }, class: 'recovery', waived: ['bluetooth'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS + n), requestedFrom: 'web' });
    assert.throws(() => plan({ ...on, pending: [pendingAdd(1)] }, { type: 'geolocation.add-zone', label: 'x', radiusM: 500, center: 'current' }), /maximum of 3 safe zones/);
    const five = [1, 2, 3, 4, 5].map(n => ({ ...pendingAdd(n), op: { type: 'wifi.add-bssid' as const, radioId: radio.id, bssid: `AA:BB:CC:DD:EE:0${n}` } }));
    assert.throws(() => plan({ ...on, pending: five }, { type: 'layer.disable', layer: 'bluetooth' }, ['wifi']), /At most 5 changes/, 'only recovery changes are pending');
    assert.doesNotThrow(() => plan({ ...on, pending: five }, { type: 'layer.disable', layer: 'bluetooth' }), 'a loosening applies at once, so pending recoveries never block it');
    assert.doesNotThrow(() => plan({ ...on, pending: five }, { type: 'device.remove', keyId: device.keyId }), 'tightening is never blocked by pending changes');
    const disabling: PendingChange = { ...pendingAdd(9), op: { type: 'layer.disable', layer: 'bluetooth' } };
    assert.throws(() => plan({ ...on, pending: [disabling] }, { type: 'layer.disable', layer: 'bluetooth' }), /already pending/);
    // Any positive cap is accepted (no server ceiling, no minimum); only a per-release cap above that asset's daily cap is refused.
    assert.throws(() => plan(off, limitsSet({ SOL: '500000000', USDC: null }, { SOL: '400000000', USDC: null })), /per-release limit cannot be above its daily limit/);
    assert.doesNotThrow(() => plan(off, limitsSet({ SOL: '1', USDC: null }, { SOL: '1', USDC: null })), 'one raw unit is a valid cap');
    assert.doesNotThrow(() => plan(off, limitsSet({ SOL: '600000000', USDC: '600000000' }, { SOL: '6000000000000', USDC: '600000000' })), 'above the old ceilings');
    assert.throws(() => plan(off, { type: 'layer.disable', layer: 'wifi' }), /already off/);
    assert.throws(() => plan(off, { type: 'wifi.add-radio', label: 'x' }), /trusted network before/);
  });
  it('parses ops strictly per route', () => {
    assert.deepEqual(parseChangeOp({ type: 'passkey.add', label: '  Laptop ' }, 'enroll'), { type: 'passkey.add', label: 'Laptop' });
    for (const [value, route] of [
      [{ type: 'passkey.add', label: 'x', extra: 1 }, 'enroll'], [{ type: 'passkey.remove', credentialId: credential.id }, 'enroll'], [{ type: 'passkey.add', label: 'x' }, 'change'],
      [{ type: 'geolocation.add-zone', label: 'x', radiusM: 99, center: 'current' }, 'enroll'], [{ type: 'geolocation.add-zone', label: 'x', radiusM: 500, center: { lat: 91, lng: 0 } }, 'enroll'],
      [{ type: 'wifi.add-network', label: 'x', cidr: '10.0.0.0/24' }, 'enroll'], [{ type: 'wifi.add-network', label: 'x', prefixLength: 23 }, 'enroll'],
      [{ type: 'layer.disable', layer: 'voice' }, 'change'], [{ type: 'voice.add' }, 'enroll'], [{ type: 'passkey.add', label: '' }, 'enroll'],
      [{ type: 'limits.set', perReleaseRaw: { SOL: '0', USDC: null }, perDayRaw: { SOL: null, USDC: null } }, 'change'],
      [{ type: 'limits.set', perReleaseRaw: { SOL: '1.5', USDC: null }, perDayRaw: { SOL: null, USDC: null } }, 'change'],
      [{ type: 'limits.set', perReleaseRaw: { SOL: 1, USDC: null }, perDayRaw: { SOL: null, USDC: null } }, 'change'],
      [{ type: 'limits.set', perReleaseRaw: { SOL: null }, perDayRaw: { SOL: null, USDC: null } }, 'change'],
      [{ type: 'passkey.add', label: 'a'.repeat(41) }, 'enroll'], [{ type: 'passkey.add', label: 'line\u0085break' }, 'enroll'],
    ] as const) assert.throws(() => parseChangeOp(value, route), GuardianError, JSON.stringify(value));
    assert.equal(cleanLabel('ok no'), null);
    // A new label must not look like a value ANTARA masks, for every op that takes one.
    for (const label of ['Office 10.0.0.1', 'Key 001A7DDA7113', 'Cabin 48.8566, 2.3522', 'AA:BB:CC:DD:EE:FF', '00-1A-7D-DA-71-13', '2001:db8:0:0:1::1']) {
      for (const op of [{ type: 'passkey.add', label }, { type: 'wifi.add-network', label }, { type: 'wifi.add-radio', label }, { type: 'bluetooth.add-device', label },
        { type: 'geolocation.add-zone', label, radiusM: 500, center: 'current' }]) {
        assert.throws(() => parseChangeOp(op, 'enroll'), /without an IP address, device ID or coordinates/, JSON.stringify(op));
      }
    }
    for (const label of ['Home', 'Office 2', 'Pixel 9', 'Studio 48', 'Flat 10.2']) assert.equal((parseChangeOp({ type: 'passkey.add', label }, 'enroll') as { label: string }).label, label);
    // Limits: optional caps, null for none, turned off with layer.disable or all-null limits.set.
    assert.deepEqual(parseChangeOp({ type: 'layer.disable', layer: 'limits' }, 'change'), { type: 'layer.disable', layer: 'limits' });
    assert.deepEqual(parseChangeOp({ type: 'limits.set', perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: '9'.repeat(30) } }, 'change'),
      { type: 'limits.set', perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: '9'.repeat(30) } });
  });
});

describe('effective configuration and evaluation', () => {
  const device = createTestDevice('desktop');
  const trusted = { keyId: device.keyId, publicKeySpki: device.publicKeySpki, surface: 'desktop' as const, label: 'PC', addedAt: iso(AT) };
  it('applies due recovery changes in order, at version +1 each, never early, and applies a legacy pending loosening at once', () => {
    const credential = passkeyRecord();
    const added = passkeyRecord(toBase64Url(new Uint8Array(16).fill(5)));
    const z = zone();
    const config = base({
      version: 4, biometrics: { credentials: [credential] }, geolocation: { zones: [z] },
      pending: [
        { id: randomId('chg'), op: { type: 'passkey.add', credential: added }, class: 'recovery', waived: ['biometrics'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS), requestedFrom: 'web' },
        { id: randomId('chg'), op: { type: 'geolocation.remove-zone', zoneId: z.id }, class: 'recovery', waived: ['geolocation'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS + 1), requestedFrom: 'web' },
        { id: randomId('chg'), op: { type: 'geolocation.remove-zone', zoneId: z.id }, class: 'recovery', waived: ['geolocation'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS + 2), requestedFrom: null },
      ],
    });
    assert.equal(effectiveConfig(config, AT + RECOVERY_DELAY_MS - 1).changed, false);
    const first = effectiveConfig(config, AT + RECOVERY_DELAY_MS).config;
    assert.equal(first.version, 5); assert.deepEqual(first.biometrics?.credentials.map(item => item.id), [credential.id, added.id]); assert.equal(first.pending.length, 2);
    const later = effectiveConfig(config, AT + RECOVERY_DELAY_MS + 2).config;
    assert.equal(later.version, 7); assert.equal(later.geolocation, null); assert.equal(later.pending.length, 0);
    assert.deepEqual(later.history.map(item => item.outcome), ['applied', 'applied', 'cancelled'], 'a change whose target is gone is recorded as cancelled');
    assert.ok(validLayerConfig(later));
    // Before it takes effect, the pending passkey is not an active credential.
    const challenge = challengeOf();
    const pendingPasskey: PasskeyOutcome = { ok: true, facts: { credentialId: added.id, newCounter: 0, surface: 'web', deviceType: 'singleDevice', backedUp: false } };
    assert.equal(evaluateLayers({ config, required: ['biometrics'], challenge, passkey: pendingPasskey, device: null, network: { status: 'not-public' }, now: AT }).ok, false);
    // A pending loosening stored before 2026-10-13 (24-hour wait) is due now; its history time is now, never in the future.
    const legacy = base({
      version: 4, biometrics: { credentials: [credential] }, geolocation: { zones: [z] },
      pending: [{ id: randomId('chg'), op: { type: 'geolocation.remove-zone', zoneId: z.id }, class: 'loosen', waived: [], requestedAt: iso(AT), effectiveAt: iso(AT + LEGACY_LOOSEN_MS), requestedFrom: 'web' }],
    });
    assert.ok(validLayerConfig(legacy));
    const applied = effectiveConfig(legacy, AT + 1);
    assert.equal(applied.changed, true); assert.equal(applied.config.geolocation, null); assert.equal(applied.config.pending.length, 0);
    assert.deepEqual(applied.config.history.map(item => [item.class, item.outcome, item.at]), [['loosen', 'applied', iso(AT + 1)]]);
    assert.ok(validLayerConfig(applied.config));
  });
  it('fails every required layer closed, one at a time', () => {
    const challenge = challengeOf();
    const z = zone();
    const net = { id: randomId('net'), label: 'Home', cidr: '203.0.113.0/24', addedAt: iso(AT) };
    const radio = { id: randomId('radio'), label: 'Home', ssid: 'Home', ssidHex: '486f6d65', bssids: ['AA:BB:CC:DD:EE:FF'], addedAt: iso(AT) };
    const bt = { id: randomId('bt'), label: 'Phone', surface: 'desktop' as const, source: 'windows-classic' as const, identifier: '001A7DDA7113', name: 'Pixel 9', addedAt: iso(AT) };
    const credential = passkeyRecord(undefined, 'desktop');
    const config = base({ biometrics: { credentials: [credential] }, geolocation: { zones: [z] }, wifi: { mode: 'network+radio', networks: [net], radios: [radio] }, bluetooth: { devices: [bt] }, devices: [trusted] });
    const passkey: PasskeyOutcome = { ok: true, facts: { credentialId: credential.id, newCounter: 1, surface: 'desktop', deviceType: 'singleDevice', backedUp: false } };
    const readings = {
      geo: { lat: z.lat, lng: z.lng, accuracyM: 20, at: AT, source: 'windows-location' as const },
      wifi: { connections: [{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' }], at: AT, source: 'windows-wlan' as const },
      bluetooth: { devices: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }], at: AT, source: 'windows-classic' as const },
    };
    const required = enabledLayers(config);
    assert.deepEqual(required, ['bluetooth', 'wifi', 'biometrics', 'geolocation']);
    const network = observeNetwork('203.0.113.9', { production: false, trustProxy: 1 });
    const run = (over: { passkey?: PasskeyOutcome; payload?: Partial<DevicePayloadV1>; network?: ReturnType<typeof observeNetwork>; device?: DeviceOutcome }) => evaluateLayers({
      config, required, challenge, now: AT, passkey: over.passkey === undefined ? passkey : over.passkey, network: over.network ?? network,
      device: over.device !== undefined ? over.device : deviceOutcome(device, devicePayload(challenge, device, { ...readings, ...over.payload })),
    });
    const pass = run({});
    // Limits is off by default, so it is not enforced; with caps set it is.
    assert.equal(pass.ok, true); assert.deepEqual(pass.enforced, ['bluetooth', 'wifi', 'biometrics', 'geolocation']);
    const capped = { ...config, limits: { perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: null } } };
    assert.deepEqual(evaluateLayers({ config: capped, required, challenge, now: AT, passkey, network, device: deviceOutcome(device, devicePayload(challenge, device, readings)) }).enforced,
      ['bluetooth', 'wifi', 'biometrics', 'geolocation', 'limits']);
    assert.deepEqual(requirementList(config, required, true, null).map(item => item.id), ['biometrics', 'geolocation', 'wifi', 'bluetooth']);
    assert.deepEqual(requirementList(capped, required, true, null).map(item => item.id), ['biometrics', 'geolocation', 'wifi', 'bluetooth', 'limits']);
    const failed = (over: Parameters<typeof run>[0]) => run(over).layers.filter(layer => !layer.ok).map(layer => layer.id);
    assert.deepEqual(failed({ passkey: null }), ['biometrics']);
    assert.deepEqual(failed({ passkey: { ok: false, reason: 'no' } }), ['biometrics']);
    assert.deepEqual(failed({ payload: { geo: { ...readings.geo, lat: z.lat + 1 } } }), ['geolocation']);
    assert.deepEqual(failed({ payload: { geo: { ...readings.geo, source: 'browser-geolocation' } } }), ['geolocation'], 'source must match the surface');
    assert.deepEqual(failed({ payload: { geo: undefined } }), ['geolocation']);
    assert.deepEqual(failed({ network: observeNetwork('198.51.100.1', { production: false, trustProxy: 1 }) }), ['wifi']);
    assert.deepEqual(failed({ network: { status: 'not-public' } }), ['wifi']);
    assert.deepEqual(failed({ payload: { wifi: { ...readings.wifi, connections: [{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:00' }] } } }), ['wifi']);
    assert.deepEqual(failed({ payload: { bluetooth: { ...readings.bluetooth, devices: [{ identifier: '001A7DDA7114', name: 'Pixel 9' }] } } }), ['bluetooth']);
    assert.deepEqual(failed({ device: null }), ['bluetooth', 'wifi', 'geolocation']);
    // Evidence from two apps is refused for every layer.
    assert.equal(run({ passkey: { ok: true, facts: { credentialId: credential.id, newCounter: 1, surface: 'web', deviceType: 'singleDevice', backedUp: false } } }).layers.every(layer => !layer.ok), true);
    // Wi-Fi radio mode needs Desktop.
    const browser = createTestDevice('web');
    const webConfig = { ...config, devices: [...config.devices, { ...trusted, keyId: browser.keyId, publicKeySpki: browser.publicKeySpki, surface: 'web' as const }] };
    const webResult = evaluateLayers({ config: webConfig, required: ['wifi'], challenge, now: AT, passkey: null, network, device: deviceOutcome(browser, devicePayload(challenge, browser)) });
    assert.match(webResult.layers[0].reason!, /requires ANTARA Desktop/);
    // Anything unexpected denies.
    assert.equal(evaluateLayers({ config: null, required: ['geolocation'], challenge, now: AT, passkey, network, device: null }).ok, false);
    assert.equal(evaluateLayers({ config: null, required: [], challenge, now: AT, passkey: null, network, device: null }).ok, true, 'no optional layer to check');
  });
  it('pins the Wi-Fi capture exception: the radio check accepts the network being added, never the trusted-network check', () => {
    const challenge = { ...challengeOf('change') };
    const net = { id: randomId('net'), label: 'Home', cidr: '203.0.113.0/24', addedAt: iso(AT) };
    const radio = { id: randomId('radio'), label: 'Home', ssid: 'Home', ssidHex: '486f6d65', bssids: ['AA:BB:CC:DD:EE:FF'], addedAt: iso(AT) };
    const credential = passkeyRecord(undefined, 'desktop');
    const config = base({ biometrics: { credentials: [credential] }, wifi: { mode: 'network+radio', networks: [net], radios: [radio] }, devices: [trusted] });
    const passkey: PasskeyOutcome = { ok: true, facts: { credentialId: credential.id, newCounter: 1, surface: 'desktop', deviceType: 'singleDevice', backedUp: false } };
    const trustedIp = observeNetwork('203.0.113.9', { production: false, trustProxy: 1 }), elsewhere = observeNetwork('198.51.100.9', { production: false, trustProxy: 1 });
    const wifi = (connections: Array<{ ssidHex: string; bssid: string }>, radioCapture?: { radioId: string } | { newRadio: true }, network = trustedIp) => evaluateLayers({
      config, required: ['wifi', 'biometrics'], challenge, passkey, network, now: AT, ...(radioCapture ? { radioCapture } : {}),
      device: deviceOutcome(device, devicePayload(challenge, device, { wifi: { connections, at: AT, source: 'windows-wlan' } })),
    }).layers.find(layer => layer.id === 'wifi')!.ok;
    const office = { ssidHex: '4f6666696365', bssid: '11:22:33:44:55:66' };
    // wifi.add-radio: exactly one connection of any name passes the radio check of its own change, from a trusted network only.
    assert.equal(wifi([office]), false, 'an untrusted Wi-Fi name fails outside a capture');
    assert.equal(wifi([office], { newRadio: true }), true);
    assert.equal(wifi([office, { ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' }], { newRadio: true }), false, 'two connections');
    assert.equal(wifi([office], { newRadio: true }, elsewhere), false, 'the server-observed network check still applies');
    // wifi.add-bssid: a new access point of that Wi-Fi name only.
    assert.equal(wifi([{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:01' }], { radioId: radio.id }), true);
    assert.equal(wifi([office], { radioId: radio.id }), false, 'another Wi-Fi name');
    assert.equal(wifi([{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:01' }], { radioId: randomId('radio') }), false, 'another radio');
  });
  it('lists Desktop Bluetooth devices by an opaque, nonce-bound id with no name, and says when an app has no trusted device', () => {
    const desktopPhone = { id: randomId('bt'), label: 'Phone', surface: 'desktop' as const, source: 'windows-classic' as const, identifier: '001A7DDA7113', name: 'Bastian Pixel', addedAt: iso(AT) };
    const webPhone = { id: randomId('bt'), label: 'Phone', surface: 'web' as const, source: 'web-bluetooth' as const, identifier: 'cGhvbmUtaWQtMDAwMQ==', name: 'Pixel 9', addedAt: iso(AT) };
    const config = base({ biometrics: { credentials: [passkeyRecord()] }, bluetooth: { devices: [desktopPhone, webPhone] } });
    const nonce = new Uint8Array(32).fill(1);
    const [bluetooth] = requirementList(config, ['bluetooth'], true, nonce) as Array<{ match: unknown[] }>;
    assert.deepEqual(bluetooth.match, [
      { surface: 'desktop', source: 'windows-classic', identifier: bluetoothMatchId(nonce, '001A7DDA7113'), name: '' },
      { surface: 'web', source: 'web-bluetooth', identifier: webPhone.identifier, name: 'Pixel 9' },
    ]);
    assert.equal(JSON.stringify(bluetooth).includes('001A7DDA'), false); assert.equal(JSON.stringify(bluetooth).includes('Bastian'), false);
    // Without a challenge (the layers-required answer) Desktop devices are left out.
    assert.deepEqual((requirementList(config, ['bluetooth'], true, null)[0] as { match: unknown[] }).match, [{ surface: 'web', source: 'web-bluetooth', identifier: webPhone.identifier, name: 'Pixel 9' }]);
    // The signed reading still carries the raw identifier, which only the server compares.
    const challenge = challengeOf();
    const desktopOnly = base({ biometrics: { credentials: [passkeyRecord()] }, bluetooth: { devices: [desktopPhone] }, devices: [trusted] });
    const check = (cfg: VaultLayerConfig, key: TestDevice, payload: Partial<DevicePayloadV1>) =>
      evaluateLayers({ config: cfg, required: ['bluetooth'], challenge, passkey: null, network: { status: 'not-public' }, now: AT, device: deviceOutcome(key, devicePayload(challenge, key, payload)) }).layers[0];
    assert.equal(check(desktopOnly, device, { bluetooth: { devices: [{ identifier: '001A7DDA7113', name: '' }], at: AT, source: 'windows-classic' } }).ok, true);
    const browser = createTestDevice('web');
    const withBrowser = { ...desktopOnly, devices: [...desktopOnly.devices, { ...trusted, keyId: browser.keyId, publicKeySpki: browser.publicKeySpki, surface: 'web' as const }] };
    assert.match(check(withBrowser, browser, { bluetooth: { devices: [{ identifier: webPhone.identifier, name: 'Pixel 9' }], at: AT, source: 'web-bluetooth' } }).reason!, /No trusted Bluetooth device is set up for Web/);
  });
  it('describes layers honestly and never returns centers, full addresses, identifiers or keys', () => {
    const credential = passkeyRecord();
    const z = zone({ lat: 12.3456789, lng: 98.7654321 });
    const net = { id: randomId('net'), label: 'Home', cidr: '203.0.113.0/24', addedAt: iso(AT) };
    const radio = { id: randomId('radio'), label: 'Home', ssid: 'MySecretSSID', ssidHex: '4d79536563726574535349', bssids: ['AA:BB:CC:DD:3F:A1'], addedAt: iso(AT) };
    const bt = { id: randomId('bt'), label: 'Phone', surface: 'desktop' as const, source: 'windows-classic' as const, identifier: '001A7DDA7113', name: 'Pixel 9', addedAt: iso(AT) };
    const disabling: PendingChange = { id: randomId('chg'), op: { type: 'layer.disable', layer: 'geolocation' }, class: 'recovery', waived: ['geolocation'], requestedAt: iso(AT), effectiveAt: iso(AT + RECOVERY_DELAY_MS), requestedFrom: 'desktop' };
    const config = base({ biometrics: { credentials: [credential] }, geolocation: { zones: [z] }, wifi: { mode: 'network+radio', networks: [net], radios: [radio] }, bluetooth: { devices: [bt] }, devices: [trusted], pending: [disabling] });
    const view = describeLayers({ config, network: observeNetwork('203.0.113.77', { production: false, trustProxy: 1 }) });
    assert.deepEqual(view.layers.map(layer => [layer.id, layer.status, layer.enforced]), [
      ['bluetooth', 'enrolled', true], ['wifi', 'enrolled', true], ['biometrics', 'enrolled', true], ['geolocation', 'pending-removal', true], ['mfa', 'not-enrolled', false], ['limits', 'not-enrolled', false],
    ]);
    // Limits is off by default: no cap, no server ceiling or minimum in the view.
    assert.deepEqual(view.layers[5].limits, { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } });
    const capped = describeLayers({ config: { ...config, limits: { perReleaseRaw: { SOL: '100000000', USDC: null }, perDayRaw: { SOL: null, USDC: '7' } } }, network: { status: 'not-public' } });
    assert.deepEqual([capped.layers[5].status, capped.layers[5].enforced, capped.layers[5].limits], ['enrolled', true, { perReleaseRaw: { SOL: '100000000', USDC: null }, perDayRaw: { SOL: null, USDC: '7' } }]);
    assert.deepEqual(view.layers[1].kinds, ['server-observed', 'device-reported']);
    assert.deepEqual(view.network, { observed: true, trusted: true });
    const text = JSON.stringify(view);
    for (const secret of ['12.345', '98.765', '203.0.113.0', '203.0.113.77', 'AA:BB:CC:DD', '001A7DDA', 'MySecretSSID', '4d7953', device.publicKeySpki.slice(0, 20), credential.publicKey.slice(0, 20)]) {
      assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), secret);
    }
    assert.match(text, /••:••:••:••:3F:A1/); assert.match(text, /ID …7113/); assert.match(text, /IPv4 203\.0\.x\.x\/24/);
    // No configuration: optional layers not enrolled; Biometrics still enforced, so releases are paused.
    const empty = describeLayers({ config: null, network: { status: 'not-public' } });
    assert.deepEqual(empty.layers.map(layer => [layer.id, layer.status, layer.enforced]), [
      ['bluetooth', 'not-enrolled', false], ['wifi', 'not-enrolled', false], ['biometrics', 'not-enrolled', true], ['geolocation', 'not-enrolled', false], ['mfa', 'not-enrolled', false], ['limits', 'not-enrolled', false],
    ]);
    assert.deepEqual(empty.network, { observed: false, trusted: null }); assert.equal(empty.configVersion, 0);
  });
});

describe('vault limits layer (optional, off by default)', () => {
  it('uses exactly the caps the user set, with no server default, ceiling or minimum', () => {
    const own = { perReleaseRaw: { SOL: '100000000', USDC: '90000000' }, perDayRaw: { SOL: '3000000000', USDC: null } };
    assert.deepEqual(effectiveReleaseLimits(own), { perRelease: { SOL: 100_000_000n, USDC: 90_000_000n }, perDay: { SOL: 3_000_000_000n, USDC: null } });
    assert.equal(effectiveReleaseLimits(null), NO_RELEASE_LIMITS);
    assert.deepEqual(effectiveReleaseLimits({ ...own, perReleaseRaw: { SOL: '1', USDC: '90000000' } }).perRelease.SOL, 1n, 'one raw unit is allowed');
    assert.throws(() => effectiveReleaseLimits({ ...own, perDayRaw: { SOL: '-1', USDC: '1' } }), /invalid/);
    assert.throws(() => effectiveReleaseLimits({ ...own, perDayRaw: { SOL: '0', USDC: '1' } }), /invalid/);
  });
  it('turns Limits on with any cap and off when every value is null', () => {
    const credential = passkeyRecord();
    const off = base({ biometrics: { credentials: [credential] } });
    const on = applyChange(off, { type: 'limits.set', perReleaseRaw: { SOL: '5', USDC: null }, perDayRaw: { SOL: null, USDC: null } });
    assert.deepEqual(on.limits, { perReleaseRaw: { SOL: '5', USDC: null }, perDayRaw: { SOL: null, USDC: null } });
    assert.ok(validLayerConfig(on));
    assert.equal(applyChange(on, { type: 'limits.set', perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } }).limits, null);
    assert.equal(applyChange(on, { type: 'layer.disable', layer: 'limits' }).limits, null);
    assert.throws(() => applyChange(off, { type: 'layer.disable', layer: 'limits' }), ChangeNotApplicableError);
    assert.equal(limitsFromChange({ perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } }), null);
  });
});

describe('stored layer configuration schema', () => {
  it('accepts a complete configuration and refuses every malformed field', () => {
    const credential = passkeyRecord();
    const good = base({ biometrics: { credentials: [credential] }, geolocation: { zones: [zone()] } });
    assert.ok(validLayerConfig(good));
    const bad: Array<[string, unknown]> = [
      ['unknown key', { ...good, extra: 1 }], ['version 0', { ...good, version: 0 }], ['empty credentials', { ...good, biometrics: { credentials: [] } }],
      ['duplicate credential', { ...good, biometrics: { credentials: [credential, credential] } }], ['empty zones', { ...good, geolocation: { zones: [] } }],
      ['radius', { ...good, geolocation: { zones: [zone({ radiusM: 99 })] } }], ['NaN latitude', { ...good, geolocation: { zones: [zone({ lat: NaN })] } }],
      ['counter', { ...good, biometrics: { credentials: [{ ...credential, counter: -1 }] } }], ['surface', { ...good, biometrics: { credentials: [{ ...credential, surface: 'phone' }] } }],
      ['private network', { ...good, wifi: { mode: 'network', networks: [{ id: randomId('net'), label: 'x', cidr: '10.0.0.0/24', addedAt: iso(AT) }], radios: [] } }],
      ['radio mode without radios', { ...good, wifi: { mode: 'network+radio', networks: [{ id: randomId('net'), label: 'x', cidr: '203.0.113.0/24', addedAt: iso(AT) }], radios: [] } }],
      ['user id', { ...good, webauthnUserId: 'short' }], ['limits', { ...good, limits: { perReleaseRaw: { SOL: '2', USDC: '1' }, perDayRaw: { SOL: '1', USDC: '1' } } }],
      ['limits with no cap stored as on', { ...good, limits: { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } } }],
      ['limits zero', { ...good, limits: { perReleaseRaw: { SOL: '0', USDC: null }, perDayRaw: { SOL: null, USDC: null } } }],
      ['bluetooth source', { ...good, bluetooth: { devices: [{ id: randomId('bt'), label: 'x', surface: 'web', source: 'windows-classic', identifier: '001A7DDA7113', name: '', addedAt: iso(AT) }] } }],
      ['pending without a valid op', { ...good, pending: [{ id: randomId('chg'), op: { type: 'voice.add' }, class: 'loosen', waived: [], requestedAt: iso(AT), effectiveAt: iso(AT + 1), requestedFrom: 'web' }] }],
      ['loosen with a waiver', { ...good, pending: [{ id: randomId('chg'), op: { type: 'layer.disable', layer: 'geolocation' }, class: 'loosen', waived: ['geolocation'], requestedAt: iso(AT), effectiveAt: iso(AT + 1), requestedFrom: 'web' }] }],
    ];
    for (const [name, value] of bad) assert.equal(validLayerConfig(value), false, name);
    assert.ok(validLayerConfig({ ...good, limits: { perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: '9'.repeat(30) } } }), 'partial caps of any size');
    assert.equal(fromBase64Url('abc='), null); assert.equal(fromBase64Url('a+b'), null); assert.ok(fromBase64Url('AAAA', { exact: 3 }));
  });
});
