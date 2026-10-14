import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LayerCollectionError, NATIVE_TIMEOUT_MS, PASSKEY_TIMEOUT_MARGIN_MS, collectBluetoothAddition, collectBluetoothChoice, collectBluetoothMatch, collectGeo, collectPasskey,
  collectWifi, connectedBluetoothDevices, createPasskey,
} from './collectors';
import { FakeNativeError as NativeError, fakePlatform } from './testPlatform';
import type { BluetoothMatch } from './types';
import { FIXTURE_BLUETOOTH_MATCH, FIXTURE_NONCE } from './testFixtures';
import { bluetoothMatchId } from './evidence';

const browser = { surface: 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: true } as const;
const position = (coords: Partial<{ latitude: number; longitude: number; accuracy: number }>, timestamp = 1_791_892_795_000) =>
  ({ getCurrentPosition: (ok: (value: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }) => void) => ok({ coords: { latitude: 48.85, longitude: 2.35, accuracy: 30, ...coords }, timestamp }) });

describe('geolocation collector', () => {
  it('reads the native location on desktop and the browser location elsewhere', async () => {
    const desktop = await collectGeo(fakePlatform({ native: { location: async () => ({ lat: 48.85, lng: 2.35, accuracyM: 20, at: 5 }) } }));
    assert.deepEqual(desktop, { lat: 48.85, lng: 2.35, accuracyM: 20, at: 5, source: 'windows-location' });
    const web = await collectGeo(fakePlatform({ capabilities: browser, browser: { geolocation: () => position({}) } }));
    assert.equal(web.source, 'browser-geolocation');
    assert.equal(web.accuracyM, 30);
  });

  it('refuses NaN, missing or zero accuracy and non-finite coordinates', async () => {
    for (const coords of [{ accuracy: 0 }, { accuracy: Number.NaN }, { accuracy: undefined as unknown as number }, { accuracy: -5 }, { latitude: Number.NaN }, { longitude: Number.POSITIVE_INFINITY }]) {
      await assert.rejects(collectGeo(fakePlatform({ capabilities: browser, browser: { geolocation: () => position(coords) } })), LayerCollectionError, JSON.stringify(coords));
    }
    await assert.rejects(collectGeo(fakePlatform({ native: { location: async () => ({ lat: 1, lng: 1, accuracyM: 0, at: 5 }) } })), LayerCollectionError);
  });

  it('fails closed when the API is missing, refused or silent', async () => {
    await assert.rejects(collectGeo(fakePlatform({ capabilities: browser })), /not available/);
    await assert.rejects(collectGeo(fakePlatform({ capabilities: { ...browser, geolocation: 'none' } })), /not available/);
    const denied = { getCurrentPosition: (_ok: unknown, fail: (error: { code: number }) => void) => fail({ code: 1 }) };
    await assert.rejects(collectGeo(fakePlatform({ capabilities: browser, browser: { geolocation: () => denied } })), /blocked/);
    const timedOut = { getCurrentPosition: (_ok: unknown, fail: (error: { code: number }) => void) => fail({ code: 3 }) };
    await assert.rejects(collectGeo(fakePlatform({ capabilities: browser, browser: { geolocation: () => timedOut } })), /timed out/);
    const consent = await collectGeo(fakePlatform({ native: { location: async () => { throw new NativeError('location-consent-required'); } } })).catch(error => error);
    assert.ok(consent instanceof LayerCollectionError);
    assert.equal(consent.action, 'open-location-settings');
    await assert.rejects(collectGeo(fakePlatform({ native: { location: async () => { throw new NativeError('accuracy-unknown'); } } })), /accurate/);
  });

  it('times out a browser that never answers', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const silent = { getCurrentPosition: () => undefined };
    const pending = collectGeo(fakePlatform({ capabilities: browser, browser: { geolocation: () => silent } }));
    context.mock.timers.tick(20_001);
    await assert.rejects(pending, /timed out/);
  });
});

describe('native commands that never answer', () => {
  const never = <T>() => new Promise<T>(() => undefined);
  it('end the step with a layer-specific message instead of leaving the panel busy', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    // Location waits for the Windows consent prompt (60 s) and a fix (20 s) before it gives up.
    const location = collectGeo(fakePlatform({ native: { location: never } })).catch(error => error);
    context.mock.timers.tick(NATIVE_TIMEOUT_MS.location - 1);
    const wifi = collectWifi(fakePlatform({ native: { wifiConnections: never } })).catch(error => error);
    const bluetooth = connectedBluetoothDevices(fakePlatform({ native: { connectedBluetooth: never } })).catch(error => error);
    context.mock.timers.tick(NATIVE_TIMEOUT_MS.wifi);
    for (const [pending, layer, pattern] of [[location, 'geolocation', /location in time/], [wifi, 'wifi', /Wi-Fi connection in time/], [bluetooth, 'bluetooth', /Bluetooth devices in time/]] as const) {
      const failure = await pending;
      assert.ok(failure instanceof LayerCollectionError);
      assert.equal(failure.layer, layer);
      assert.match(failure.message, pattern);
    }
    assert.ok(NATIVE_TIMEOUT_MS.location > 80_000, 'longer than the native consent wait plus the fix wait');
  });
  it('end a passkey prompt at the server timeout plus a margin', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const request = { challenge: 'abc', rpId: 'antara.tech', allowCredentials: [{ id: 'Y3JlZA', type: 'public-key' as const }], userVerification: 'required' as const, timeout: 60_000 };
    let settled = false;
    const pending = collectPasskey(fakePlatform({ native: { passkeyGet: never } }), request).catch(error => { settled = true; return error; });
    context.mock.timers.tick(60_000 + PASSKEY_TIMEOUT_MARGIN_MS - 1);
    await Promise.resolve();
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    const failure = await pending;
    assert.ok(failure instanceof LayerCollectionError);
    assert.match(failure.message, /cancelled or timed out/);
    assert.equal(failure.capture, false);
  });
});

describe('Wi-Fi collector (desktop only)', () => {
  it('sends only SSID bytes and BSSIDs, and keeps the names for display', async () => {
    const reading = await collectWifi(fakePlatform({ native: { wifiConnections: async () => [{ ssid: 'Home', ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' }] } }));
    assert.deepEqual(reading.connections, [{ ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' }]);
    assert.deepEqual(reading.names, ['Home']);
    assert.equal(reading.source, 'windows-wlan');
  });
  it('refuses off desktop, on missing consent and on malformed output', async () => {
    await assert.rejects(collectWifi(fakePlatform({ capabilities: browser })), /requires ANTARA Desktop/);
    const consent = await collectWifi(fakePlatform({ native: { wifiConnections: async () => { throw new NativeError('location-consent-required'); } } })).catch(error => error);
    assert.equal(consent.action, 'open-location-settings');
    assert.match(consent.message, /Windows Settings/);
    await assert.rejects(collectWifi(fakePlatform({ native: { wifiConnections: async () => [{ ssid: 'Home', ssidHex: '486f6d65', bssid: 'aa:bb:cc:dd:ee:ff' }] } })), LayerCollectionError);
    await assert.rejects(collectWifi(fakePlatform({ native: { wifiConnections: async () => [] } })), LayerCollectionError);
  });
});

describe('Bluetooth collectors', () => {
  const match: BluetoothMatch[] = [
    { surface: 'desktop', source: 'windows-classic', identifier: FIXTURE_BLUETOOTH_MATCH, name: '' },
    { surface: 'web', source: 'web-bluetooth', identifier: 'Zm9vYmFy', name: 'Pixel 9' },
  ];
  it('computes the server’s opaque Desktop match id (pinned vectors from server digest.ts)', async () => {
    assert.equal(await bluetoothMatchId('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', '001A7DDA7113'), 'A81499E93C60');
    assert.equal(await bluetoothMatchId(FIXTURE_NONCE, '001A7DDA7113'), FIXTURE_BLUETOOTH_MATCH);
    assert.equal(await bluetoothMatchId(FIXTURE_NONCE, 'A1B2C3D4E5F6'), 'A6CAFBB19C42');
    // Bound to the challenge: another nonce gives another id, so a match list cannot be reused or looked up.
    assert.notEqual(await bluetoothMatchId('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', 'A1B2C3D4E5F6'), 'A6CAFBB19C42');
    await assert.rejects(bluetoothMatchId('AAEC', '001A7DDA7113'));
  });
  it('desktop never matches a raw hardware address the server did not hash for this challenge', async () => {
    const raw: BluetoothMatch[] = [{ surface: 'desktop', source: 'windows-classic', identifier: '001A7DDA7113', name: 'Pixel 9' }];
    await assert.rejects(collectBluetoothMatch(fakePlatform({ native: { connectedBluetooth: async () => [{ id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' }] } }), raw, FIXTURE_NONCE), /not connected/);
  });
  it('desktop sends only connected devices that are enrolled, never the full list', async () => {
    const reading = await collectBluetoothMatch(fakePlatform({ native: { connectedBluetooth: async () => [
      { id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' }, { id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' },
    ] } }), match, FIXTURE_NONCE);
    assert.deepEqual(reading, { devices: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }], at: 1_791_892_800_000, source: 'windows-classic' });
    await assert.rejects(collectBluetoothMatch(fakePlatform({ native: { connectedBluetooth: async () => [{ id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' }] } }), match, FIXTURE_NONCE), /not connected/);
    await assert.rejects(collectBluetoothMatch(fakePlatform({ native: { connectedBluetooth: async () => { throw new NativeError('bluetooth-unavailable'); } } }), match, FIXTURE_NONCE), /off or unavailable/);
  });
  it('browsers filter the chooser to the enrolled names and refuse another device', async () => {
    let options: unknown;
    const requestDevice = async (value: unknown) => { options = value; return { id: 'Zm9vYmFy', name: 'Pixel 9' }; };
    const reading = await collectBluetoothMatch(fakePlatform({ capabilities: browser, browser: { bluetooth: () => ({ requestDevice }) } }), match, FIXTURE_NONCE);
    assert.deepEqual(options, { filters: [{ name: 'Pixel 9' }] });
    assert.deepEqual(reading.devices, [{ identifier: 'Zm9vYmFy', name: 'Pixel 9' }]);
    const other = { requestDevice: async () => ({ id: 'b3RoZXI', name: 'Pixel 9' }) };
    await assert.rejects(collectBluetoothMatch(fakePlatform({ capabilities: browser, browser: { bluetooth: () => other } }), match, FIXTURE_NONCE), /not your trusted Bluetooth device/);
    await assert.rejects(collectBluetoothMatch(fakePlatform({ capabilities: { ...browser, surface: 'extension' }, browser: { bluetooth: () => ({ requestDevice }) } }), match, FIXTURE_NONCE), /No trusted Bluetooth device is set up/);
    await assert.rejects(collectBluetoothMatch(fakePlatform({ capabilities: browser }), match, FIXTURE_NONCE), /not available/);
    const cancelled = { requestDevice: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundError' }); } };
    await assert.rejects(collectBluetoothMatch(fakePlatform({ capabilities: browser, browser: { bluetooth: () => cancelled } }), match, FIXTURE_NONCE), /No Bluetooth device was chosen/);
  });
  it('adding a device while Bluetooth is on reads the trusted device and exactly one new one together', async () => {
    const connected = [{ id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' as const }, { id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' as const }];
    const desktop = fakePlatform({ native: { connectedBluetooth: async () => connected } });
    const reading = await collectBluetoothAddition(desktop, match, FIXTURE_NONCE, 'A1B2C3D4E5F6', null);
    assert.deepEqual(reading, { devices: [{ identifier: '001A7DDA7113', name: 'Pixel 9' }, { identifier: 'A1B2C3D4E5F6', name: 'Headphones' }], at: 1_791_892_800_000, source: 'windows-classic' });
    // The trusted device is not a new one, and a new device alone does not prove the layer.
    const again = await collectBluetoothAddition(desktop, match, FIXTURE_NONCE, '001A7DDA7113', null).catch(error => error);
    assert.equal(again.capture, true);
    const alone = await collectBluetoothAddition(fakePlatform({ native: { connectedBluetooth: async () => [connected[1]] } }), match, FIXTURE_NONCE, 'A1B2C3D4E5F6', null).catch(error => error);
    assert.match(alone.message, /not connected/);
    assert.equal(alone.capture, false);

    // Chrome: the trusted device comes from an earlier click; this click chooses the new one.
    const options: unknown[] = [];
    const chrome = (pick: { id: string; name: string }) => fakePlatform({ capabilities: browser, browser: { bluetooth: () => ({ requestDevice: async (value: unknown) => { options.push(value); return pick; } }) } });
    const matched = await collectBluetoothMatch(chrome({ id: 'Zm9vYmFy', name: 'Pixel 9' }), match, FIXTURE_NONCE);
    const added = await collectBluetoothAddition(chrome({ id: 'bmV3', name: 'Headphones' }), match, FIXTURE_NONCE, null, { ...matched, at: 5 });
    assert.deepEqual(added, { devices: [{ identifier: 'Zm9vYmFy', name: 'Pixel 9' }, { identifier: 'bmV3', name: 'Headphones' }], at: 5, source: 'web-bluetooth' });
    assert.deepEqual(options, [{ filters: [{ name: 'Pixel 9' }] }, { acceptAllDevices: true }]);
    await assert.rejects(collectBluetoothAddition(chrome({ id: 'bmV3', name: 'Headphones' }), match, FIXTURE_NONCE, null, null), /trusted Bluetooth device first/);
    const same = await collectBluetoothAddition(chrome({ id: 'Zm9vYmFy', name: 'Pixel 9' }), match, FIXTURE_NONCE, null, matched).catch(error => error);
    assert.match(same.message, /already trusted/);
    assert.equal(same.capture, true);
    const forged = await collectBluetoothAddition(chrome({ id: 'bmV3', name: 'Headphones' }), match, FIXTURE_NONCE, null, { ...matched, devices: [{ identifier: 'b3RoZXI', name: 'Pixel 9' }] }).catch(error => error);
    assert.match(forged.message, /trusted Bluetooth device first/);
  });

  it('enrollment captures exactly one device', async () => {
    const desktop = await collectBluetoothChoice(fakePlatform({ native: { connectedBluetooth: async () => [{ id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' }, { id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' }] } }), 'A1B2C3D4E5F6');
    assert.deepEqual(desktop.devices, [{ identifier: 'A1B2C3D4E5F6', name: 'Headphones' }]);
    await assert.rejects(collectBluetoothChoice(fakePlatform({ native: { connectedBluetooth: async () => [] } }), 'A1B2C3D4E5F6'), /Choose a Bluetooth device/);
    let options: unknown;
    const web = await collectBluetoothChoice(fakePlatform({ capabilities: browser, browser: { bluetooth: () => ({ requestDevice: async (value: unknown) => { options = value; return { id: 'Zm9vYmFy', name: 'Pixel 9' }; } }) } }), null);
    assert.deepEqual(options, { acceptAllDevices: true });
    assert.equal(web.source, 'web-bluetooth');
    await assert.rejects(collectBluetoothChoice(fakePlatform({ capabilities: browser, browser: { bluetooth: () => ({ requestDevice: async () => ({ id: 'Zm9vYmFy', name: null }) }) } }), null), /does not share a name/);
  });
});

describe('passkey ceremonies', () => {
  const request = { challenge: 'abc', rpId: 'antara.tech', allowCredentials: [{ id: 'Y3JlZA', type: 'public-key' as const }], userVerification: 'required' as const, timeout: 120000 };
  const response = { id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key' as const, response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} };
  it('uses the native commands on desktop and the browser elsewhere', async () => {
    const calls: string[] = [];
    assert.equal((await collectPasskey(fakePlatform({ native: { passkeyGet: async () => { calls.push('native'); return response; } } }), request)).id, 'Y3JlZA');
    assert.equal((await collectPasskey(fakePlatform({ capabilities: browser, browser: { startAuthentication: async () => { calls.push('browser'); return response; } } }), request)).id, 'Y3JlZA');
    assert.deepEqual(calls, ['native', 'browser']);
  });
  it('refuses requests without user verification, and maps cancellations', async () => {
    await assert.rejects(collectPasskey(fakePlatform(), { ...request, userVerification: 'preferred' }), /could not start/);
    await assert.rejects(collectPasskey(fakePlatform({ capabilities: { passkey: 'none' } }), request), /not available/);
    await assert.rejects(collectPasskey(fakePlatform({ native: { passkeyGet: async () => { throw new NativeError('passkey-cancelled'); } } }), request), /cancelled/);
    await assert.rejects(collectPasskey(fakePlatform({ capabilities: browser, browser: { startAuthentication: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } }), request), /cancelled/);
    const creation = { rp: { id: 'antara.tech', name: 'ANTARA' }, user: { id: 'dXNlcg', name: 'a', displayName: 'a' }, challenge: 'abc', pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
      authenticatorSelection: { userVerification: 'preferred' as const }, attestation: 'none' as const };
    await assert.rejects(createPasskey(fakePlatform(), creation), /could not start/);
    await assert.rejects(createPasskey(fakePlatform(), { ...creation, authenticatorSelection: { userVerification: 'required' }, attestation: 'direct' }), /could not start/);
  });
  it('marks a failed new passkey as a capture failure, and a failed existing passkey as a layer failure', async () => {
    const creation = { rp: { id: 'antara.tech', name: 'ANTARA' }, user: { id: 'dXNlcg', name: 'a', displayName: 'a' }, challenge: 'abc', pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
      authenticatorSelection: { userVerification: 'required' as const }, attestation: 'none' as const, timeout: 120000 };
    const cancelled = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
    for (const platform of [fakePlatform({ native: { passkeyCreate: cancelled } }), fakePlatform({ capabilities: browser, browser: { startRegistration: cancelled } }), fakePlatform({ capabilities: { passkey: 'none' } })]) {
      const failure = await createPasskey(platform, creation).catch(error => error);
      assert.ok(failure instanceof LayerCollectionError);
      assert.equal(failure.layer, 'biometrics');
      assert.equal(failure.capture, true);
    }
    const assertion = await collectPasskey(fakePlatform({ native: { passkeyGet: async () => { throw new NativeError('passkey-cancelled'); } } }), request).catch(error => error);
    assert.equal(assertion.capture, false);
  });
});
