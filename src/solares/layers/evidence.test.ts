import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { assertReading, assertReleaseMatches, base64UrlDecode, base64UrlEncode, buildDevicePayload, encodeDevicePayload, webauthnChallenge } from './evidence';
import { deviceKeyName, ensureDeviceKey, keyIdOf, loadDeviceKey, memoryDeviceKeyStorage, signDevicePayload } from './deviceKey';
import {
  FIXTURE_CHALLENGE_ID, FIXTURE_DIGEST, FIXTURE_MULTISIG, FIXTURE_NONCE, FIXTURE_RECIPIENT, FIXTURE_USER, FIXTURE_WEBAUTHN_CREATE, FIXTURE_WEBAUTHN_GET,
} from './testFixtures';

const geo = { lat: 48.8566, lng: 2.3522, accuracyM: 35, at: 1791892795000, source: 'windows-location' as const };
const wifi = { connections: [{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' }], at: 1791892796000, source: 'windows-wlan' as const };
const bluetooth = { devices: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }], at: 1791892797000, source: 'windows-classic' as const };
const base = { purpose: 'release' as const, challengeId: FIXTURE_CHALLENGE_ID, nonce: FIXTURE_NONCE, digest: FIXTURE_DIGEST, keyId: 'AbCdEfGhIjKlMnOpQrStUv', surface: 'desktop' as const, signedAt: 1791892800000 };

describe('section 6 binding values', () => {
  it('derives the WebAuthn challenge exactly as the server does (pinned vectors)', async () => {
    assert.equal(await webauthnChallenge('get', FIXTURE_NONCE, FIXTURE_DIGEST), FIXTURE_WEBAUTHN_GET);
    assert.equal(await webauthnChallenge('create', FIXTURE_NONCE, FIXTURE_DIGEST), FIXTURE_WEBAUTHN_CREATE);
    // Independent recomputation of SHA256(label || 0x00 || nonce || digest).
    const expected = createHash('sha256').update('ANTARA vault layers v1 get').update(Buffer.of(0)).update(Buffer.from(FIXTURE_NONCE, 'base64url')).update(Buffer.from(FIXTURE_DIGEST, 'hex')).digest('base64url');
    assert.equal(expected, FIXTURE_WEBAUTHN_GET);
    await assert.rejects(webauthnChallenge('get', 'AAEC', FIXTURE_DIGEST));
    await assert.rejects(webauthnChallenge('get', FIXTURE_NONCE, 'abcd'));
  });

  it('encodes base64url without padding and refuses invalid input', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0x01]);
    assert.equal(base64UrlEncode(bytes), '-_8B');
    assert.deepEqual(base64UrlDecode('-_8B'), bytes);
    assert.throws(() => base64UrlDecode('a+b/'));
    assert.throws(() => base64UrlDecode('abcde'));
  });
});

describe('DevicePayloadV1', () => {
  it('has exactly the section 6.3 field set, in order, and omits readings that are not required', () => {
    const full = buildDevicePayload({ ...base, geo, wifi, bluetooth });
    assert.deepEqual(Object.keys(full), ['v', 'purpose', 'challengeId', 'nonce', 'digest', 'keyId', 'surface', 'signedAt', 'geo', 'wifi', 'bluetooth']);
    assert.deepEqual(Object.keys(full.geo!), ['lat', 'lng', 'accuracyM', 'at', 'source']);
    assert.deepEqual(Object.keys(full.wifi!), ['connections', 'at', 'source']);
    assert.deepEqual(Object.keys(full.bluetooth!), ['devices', 'at', 'source']);
    assert.equal(full.v, 1);
    const onlyGeo = buildDevicePayload({ ...base, geo });
    assert.deepEqual(Object.keys(onlyGeo), ['v', 'purpose', 'challengeId', 'nonce', 'digest', 'keyId', 'surface', 'signedAt', 'geo']);
    // Extra properties on a reading are never copied into the signed bytes.
    const extra = buildDevicePayload({ ...base, bluetooth: { ...bluetooth, devices: [{ ...bluetooth.devices[0], rssi: -40 } as never] } });
    assert.deepEqual(extra.bluetooth!.devices, [{ identifier: '001A7DDA7113', name: 'Pixel 9' }]);
  });

  it('refuses readings that fail closed: missing, zero or non-finite accuracy, wrong sources for the surface', () => {
    for (const accuracyM of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      assert.throws(() => buildDevicePayload({ ...base, geo: { ...geo, accuracyM: accuracyM as number } }), String(accuracyM));
    }
    for (const change of [{ lat: 91 }, { lng: -181 }, { lat: Number.NaN }, { at: 0 }, { source: 'browser-geolocation' as const }]) {
      assert.throws(() => buildDevicePayload({ ...base, geo: { ...geo, ...change } }), JSON.stringify(change));
    }
    // Wi-Fi readings exist only on ANTARA Desktop.
    assert.throws(() => buildDevicePayload({ ...base, surface: 'web', wifi }), /ANTARA Desktop/);
    assert.throws(() => buildDevicePayload({ ...base, wifi: { ...wifi, connections: [{ ssidHex: '486f6d65', bssid: 'aa:bb:cc:dd:ee:ff' }] } }));
    assert.throws(() => buildDevicePayload({ ...base, wifi: { ...wifi, connections: [] } }));
    assert.throws(() => buildDevicePayload({ ...base, bluetooth: { ...bluetooth, source: 'web-bluetooth' } }));
    assert.throws(() => buildDevicePayload({ ...base, bluetooth: { ...bluetooth, devices: [{ identifier: '00:1A:7D:DA:71:13', name: 'Pixel 9' }] } }));
    assert.throws(() => buildDevicePayload({ ...base, surface: 'extension', bluetooth: { ...bluetooth, devices: [] , source: 'web-bluetooth' } }));
    assert.doesNotThrow(() => assertReading('extension', 'bluetooth', { devices: [{ identifier: 'Zm9vYmFyYmF6PT0=', name: '' }], at: 1, source: 'web-bluetooth' }));
    assert.throws(() => buildDevicePayload({ ...base, signedAt: Number.NaN }));
  });

  it('refuses a payload over 4 KB, and more Bluetooth devices than the server reads', () => {
    const devices = Array.from({ length: 8 }, (_, index) => ({ identifier: 'x'.repeat(64), name: `${index}`.padEnd(64, 'n') }));
    const payload = buildDevicePayload({ ...base, surface: 'web', bluetooth: { devices, at: 1, source: 'web-bluetooth' } });
    assert.throws(() => encodeDevicePayload({ ...payload, bluetooth: { ...payload.bluetooth!, devices: Array.from({ length: 6 }, () => devices).flat() } }), /too large/);
    assert.throws(() => buildDevicePayload({ ...base, surface: 'web', bluetooth: { devices: [...devices, devices[0]], at: 1, source: 'web-bluetooth' } }), /Bluetooth reading is incomplete/);
  });
});

describe('release check before any prompt (section 12 step 3)', () => {
  const release = { multisig: FIXTURE_MULTISIG, transactionIndex: '12', asset: 'SOL' as const, amountRaw: '250000000', recipient: FIXTURE_RECIPIENT };
  it('passes only an identical release', () => {
    assert.doesNotThrow(() => assertReleaseMatches(release, { ...release }));
    for (const change of [{ multisig: FIXTURE_RECIPIENT }, { transactionIndex: '13' }, { asset: 'USDC' as const }, { amountRaw: '250000001' }, { recipient: FIXTURE_MULTISIG }]) {
      assert.throws(() => assertReleaseMatches({ ...release, ...change }, release), /different release\. Nothing was approved/, JSON.stringify(change));
    }
  });
});

describe('trusted device keys (section 5.3)', () => {
  it('creates a non-extractable P-256 key whose signature node:crypto verifies as IEEE P1363', async () => {
    const storage = memoryDeviceKeyStorage();
    const key = await ensureDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG, 'desktop', () => 1_791_892_800_000);
    const spki = Buffer.from(key.publicKeySpki, 'base64url');
    assert.equal(key.keyId, createHash('sha256').update(spki).digest().subarray(0, 16).toString('base64url'));
    assert.equal(key.keyId.length, 22);
    assert.equal(await keyIdOf(new Uint8Array(spki)), key.keyId);
    const record = await storage.get(deviceKeyName(FIXTURE_USER, FIXTURE_MULTISIG));
    assert.equal(record?.keyPair.privateKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('pkcs8', record!.keyPair.privateKey));

    const payload = buildDevicePayload({ ...base, keyId: key.keyId, geo, bluetooth });
    const signed = await signDevicePayload(key, payload);
    assert.equal(signed.keyId, key.keyId);
    const bytes = Buffer.from(signed.payload, 'base64url');
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), payload);
    const signature = Buffer.from(signed.signature, 'base64url');
    assert.equal(signature.length, 64);
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.equal(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
    // One flipped byte fails, as on the server.
    const flipped = Buffer.from(bytes); flipped[10] ^= 1;
    assert.equal(verify('sha256', flipped, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), false);
  });

  it('keeps one key per user and vault, and refuses payloads prepared for another key or surface', async () => {
    const storage = memoryDeviceKeyStorage();
    const first = await ensureDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG, 'web');
    const again = await ensureDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG, 'web');
    assert.equal(again.keyId, first.keyId);
    const other = await ensureDeviceKey(storage, FIXTURE_USER, FIXTURE_RECIPIENT, 'web');
    assert.notEqual(other.keyId, first.keyId);
    assert.equal(await loadDeviceKey(storage, 'privy:someone-else', FIXTURE_MULTISIG), null);
    await assert.rejects(signDevicePayload(first, buildDevicePayload({ ...base, surface: 'web', keyId: other.keyId })), /different device key/);
    await assert.rejects(signDevicePayload(first, buildDevicePayload({ ...base, surface: 'desktop', keyId: first.keyId })), /different device key/);
  });

  it('treats a tampered stored record as unreadable instead of using it', async () => {
    const storage = memoryDeviceKeyStorage();
    const key = await ensureDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG, 'extension');
    const record = (await storage.get(deviceKeyName(FIXTURE_USER, FIXTURE_MULTISIG)))!;
    await storage.put(deviceKeyName(FIXTURE_USER, FIXTURE_MULTISIG), { ...record, keyId: key.keyId.replace(/^./, key.keyId[0] === 'A' ? 'B' : 'A') });
    await assert.rejects(loadDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG), /unreadable/);
    const extractable = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    await storage.put(deviceKeyName(FIXTURE_USER, FIXTURE_MULTISIG), { ...record, keyPair: extractable });
    await assert.rejects(loadDeviceKey(storage, FIXTURE_USER, FIXTURE_MULTISIG), /unreadable/);
  });
});
