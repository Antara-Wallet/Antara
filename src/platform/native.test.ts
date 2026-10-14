import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  NATIVE_PASSKEY_ORIGIN, NativeLayerError, nativeConnectedBluetooth, nativeLocation, nativePasskeyCreate, nativePasskeyGet, nativeWifiConnections,
  openLocationSettings, type NativeErrorCode,
} from './native';

type Globals = Record<string, unknown>;
type Call = { cmd: string; args: unknown };

function withGlobals(values: Globals, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Globals)[key];
    }
  };
  return Promise.resolve().then(run).finally(restore);
}

/**
 * Runs `run` inside a fake Tauri webview: @tauri-apps/api/core's invoke reaches
 * window.__TAURI_INTERNALS__.invoke, which answers with `answer(cmd, args)`.
 */
async function inTauri(answer: (cmd: string, args: unknown) => unknown, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const invoke = async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return answer(cmd, args);
  };
  await withGlobals({ isTauri: true, window: { __TAURI_INTERNALS__: { invoke } } }, () => run(calls));
}

/** Command answers `value` (a rejected promise when `reject` is set, as Tauri does for Err). */
const answering = (value: unknown, reject = false) => async () => { if (reject) throw value; return value; };

async function rejectsWith(promise: Promise<unknown>, code: NativeErrorCode, label: string = code) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof NativeLayerError, `${label}: ${String(error)}`);
    assert.equal(error.code, code, label);
    assert.ok(error.message.length > 0);
    return true;
  });
}

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');

// ---- Outside the desktop app -------------------------------------------------

test('every wrapper is unsupported outside ANTARA Desktop and never invokes anything', async () => {
  await rejectsWith(nativeWifiConnections(), 'unsupported-platform');
  await rejectsWith(nativeConnectedBluetooth(), 'unsupported-platform');
  await rejectsWith(nativeLocation(), 'unsupported-platform');
  await rejectsWith(nativePasskeyGet(getOptions()), 'unsupported-platform');
  await rejectsWith(nativePasskeyCreate(createOptions()), 'unsupported-platform');
  await rejectsWith(openLocationSettings(), 'unsupported-platform');
});

// ---- Error mapping -------------------------------------------------------------

test('Rust error strings map to their codes; unknown or foreign errors map to the command fallback', async () => {
  const cases: Array<[() => Promise<unknown>, unknown, NativeErrorCode]> = [
    [nativeWifiConnections, 'location-consent-required', 'location-consent-required'],
    [nativeWifiConnections, 'not-connected', 'not-connected'],
    [nativeWifiConnections, 'wifi-unavailable', 'wifi-unavailable'],
    [nativeWifiConnections, 'unsupported-platform', 'unsupported-platform'],
    [nativeWifiConnections, 'layer_wifi_connections not allowed. Permissions associated with this command: []', 'wifi-unavailable'],
    [nativeWifiConnections, 'passkey-cancelled', 'wifi-unavailable'],
    [nativeConnectedBluetooth, 'bluetooth-unavailable', 'bluetooth-unavailable'],
    [nativeConnectedBluetooth, 'not-connected', 'bluetooth-unavailable'],
    [nativeConnectedBluetooth, { message: 'boom' }, 'bluetooth-unavailable'],
    [nativeLocation, 'location-consent-required', 'location-consent-required'],
    [nativeLocation, 'accuracy-unknown', 'accuracy-unknown'],
    [nativeLocation, 'location-unavailable', 'location-unavailable'],
    [nativeLocation, 'Command layer_location not found', 'location-unavailable'],
    [() => nativePasskeyGet(getOptions()), 'passkey-cancelled', 'passkey-cancelled'],
    [() => nativePasskeyGet(getOptions()), 'invalid-request', 'invalid-request'],
    [() => nativePasskeyGet(getOptions()), 'NotAllowedError', 'passkey-failed'],
    [() => nativePasskeyCreate(createOptions()), 'passkey-failed', 'passkey-failed'],
    [() => nativePasskeyCreate(createOptions()), 'wifi-unavailable', 'passkey-failed'],
    [openLocationSettings, 'unsupported-platform', 'unsupported-platform'],
    // The Windows command answers location-unavailable when the settings page does not open.
    [openLocationSettings, 'location-unavailable', 'location-unavailable'],
    [openLocationSettings, 'something else', 'location-unavailable'],
  ];
  for (const [call, error, code] of cases) {
    await inTauri(answering(error, true), async () => rejectsWith(call(), code, `${String(JSON.stringify(error))} -> ${code}`));
  }
});

// ---- Wi-Fi -------------------------------------------------------------------

const WIFI = { ssid: 'Home', ssidHex: '486F6D65', bssid: 'AA:BB:CC:DD:EE:FF' };

test('Wi-Fi: a well-formed reading passes through with the SSID bytes lowercased', async () => {
  await inTauri(answering([WIFI, { ssid: '�', ssidHex: 'ff', bssid: '00:1A:7D:DA:71:13' }]), async calls => {
    assert.deepEqual(await nativeWifiConnections(), [
      { ssid: 'Home', ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:FF' },
      { ssid: '�', ssidHex: 'ff', bssid: '00:1A:7D:DA:71:13' },
    ]);
    assert.deepEqual(calls, [{ cmd: 'layer_wifi_connections', args: {} }]);
  });
});

test('Wi-Fi: malformed readings are refused, never repaired', async () => {
  const malformed: Array<[string, unknown]> = [
    ['empty SSID', [{ ...WIFI, ssid: '' }]],
    ['lowercase BSSID', [{ ...WIFI, bssid: 'aa:bb:cc:dd:ee:ff' }]],
    ['short BSSID', [{ ...WIFI, bssid: 'AA:BB:CC:DD:EE' }]],
    ['dashed BSSID', [{ ...WIFI, bssid: 'AA-BB-CC-DD-EE-FF' }]],
    ['zero BSSID', [{ ...WIFI, bssid: '00:00:00:00:00:00' }]],
    ['broadcast BSSID', [{ ...WIFI, bssid: 'FF:FF:FF:FF:FF:FF' }]],
    ['odd SSID hex', [{ ...WIFI, ssidHex: '486f6d6' }]],
    ['non-hex SSID', [{ ...WIFI, ssidHex: 'zz' }]],
    ['empty SSID hex', [{ ...WIFI, ssidHex: '' }]],
    ['33-byte SSID', [{ ...WIFI, ssid: 'x', ssidHex: 'ab'.repeat(33) }]],
    ['SSID text longer than its bytes', [{ ...WIFI, ssid: 'Home!', ssidHex: '486f6d65' }]],
    ['unknown field', [{ ...WIFI, rssi: -40 }]],
    ['missing field', [{ ssid: 'Home', ssidHex: '486f6d65' }]],
    ['number BSSID', [{ ...WIFI, bssid: 1 }]],
    ['not an array', WIFI],
    ['null', null],
    ['too many', Array.from({ length: 9 }, () => WIFI)],
  ];
  for (const [label, value] of malformed) {
    await inTauri(answering(value), async () => rejectsWith(nativeWifiConnections(), 'wifi-unavailable', label));
  }
  await inTauri(answering([]), async () => rejectsWith(nativeWifiConnections(), 'not-connected', 'empty list'));
});

// ---- Bluetooth -----------------------------------------------------------------

const PHONE = { id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' };

test('Bluetooth: connected devices pass through; none connected is an empty list', async () => {
  await inTauri(answering([PHONE, { id: 'A1B2C3D4E5F6', name: '', kind: 'classic' }]), async calls => {
    assert.deepEqual(await nativeConnectedBluetooth(), [PHONE, { id: 'A1B2C3D4E5F6', name: '', kind: 'classic' }]);
    assert.deepEqual(calls, [{ cmd: 'layer_bluetooth_connected', args: {} }]);
  });
  await inTauri(answering([]), async () => assert.deepEqual(await nativeConnectedBluetooth(), []));
  // The command names an unnamed device itself; matching always uses the address.
  const many = Array.from({ length: 256 }, (_, index) => ({ id: (index + 1).toString(16).toUpperCase().padStart(12, '0'), name: 'Unknown device', kind: 'classic' }));
  await inTauri(answering(many), async () => assert.equal((await nativeConnectedBluetooth()).length, 256));
});

test('Bluetooth: malformed device lists are refused', async () => {
  const malformed: Array<[string, unknown]> = [
    ['lowercase address', [{ ...PHONE, id: '001a7dda7113' }]],
    ['short address', [{ ...PHONE, id: '001A7DDA71' }]],
    ['colon address', [{ ...PHONE, id: '00:1A:7D:DA:71:13' }]],
    ['zero address', [{ ...PHONE, id: '000000000000' }]],
    ['duplicate address', [PHONE, PHONE]],
    ['unknown kind', [{ ...PHONE, kind: 'usb' }]],
    ['connected flag (legacy shape)', [{ ...PHONE, connected: true }]],
    ['missing name', [{ id: PHONE.id, kind: 'classic' }]],
    ['name too long', [{ ...PHONE, name: 'x'.repeat(249) }]],
    ['not an array', PHONE],
    ['more than the command enumerates', Array.from({ length: 257 }, (_, index) => ({ ...PHONE, id: (index + 1).toString(16).toUpperCase().padStart(12, '0') }))],
  ];
  for (const [label, value] of malformed) {
    await inTauri(answering(value), async () => rejectsWith(nativeConnectedBluetooth(), 'bluetooth-unavailable', label));
  }
});

// ---- Location ------------------------------------------------------------------

const PARIS = { lat: 48.8566, lng: 2.3522, accuracyM: 35, at: 1_791_892_795_000 };

test('Location: a complete reading passes through unchanged', async () => {
  await inTauri(answering(PARIS), async calls => {
    assert.deepEqual(await nativeLocation(), PARIS);
    assert.deepEqual(calls, [{ cmd: 'layer_location', args: {} }]);
  });
});

test('Location: missing, zero, negative or non-finite accuracy is accuracy-unknown, never 0', async () => {
  const { accuracyM: _omitted, ...withoutAccuracy } = PARIS;
  const cases: Array<[string, unknown]> = [
    ['missing accuracyM', withoutAccuracy],
    ['accuracyM 0', { ...PARIS, accuracyM: 0 }],
    ['accuracyM -1', { ...PARIS, accuracyM: -1 }],
    ['accuracyM NaN', { ...PARIS, accuracyM: Number.NaN }],
    ['accuracyM Infinity', { ...PARIS, accuracyM: Number.POSITIVE_INFINITY }],
    ['accuracyM null (serde NaN)', { ...PARIS, accuracyM: null }],
    ['accuracyM string', { ...PARIS, accuracyM: '35' }],
    ['legacy accuracy_m field', { lat: PARIS.lat, lng: PARIS.lng, accuracy_m: 0, at: PARIS.at }],
  ];
  for (const [label, value] of cases) {
    await inTauri(answering(value), async () => rejectsWith(nativeLocation(), 'accuracy-unknown', label));
  }
});

test('Location: malformed coordinates or timestamps are refused', async () => {
  const cases: Array<[string, unknown]> = [
    ['lat NaN', { ...PARIS, lat: Number.NaN }],
    ['lat null', { ...PARIS, lat: null }],
    ['lat 91', { ...PARIS, lat: 91 }],
    ['lng -181', { ...PARIS, lng: -181 }],
    ['lng Infinity', { ...PARIS, lng: Number.POSITIVE_INFINITY }],
    ['lat string', { ...PARIS, lat: '48.8' }],
    ['at 0', { ...PARIS, at: 0 }],
    ['at fractional', { ...PARIS, at: 1.5 }],
    ['at missing', { lat: PARIS.lat, lng: PARIS.lng, accuracyM: 35 }],
    ['unknown field', { ...PARIS, altitude: 30 }],
    ['array', [PARIS]],
    ['null', null],
  ];
  for (const [label, value] of cases) {
    await inTauri(answering(value), async () => rejectsWith(nativeLocation(), 'location-unavailable', label));
  }
});

// ---- Passkeys ------------------------------------------------------------------

const RP_ID = 'antara.tech';
const CHALLENGE = b64url(createHash('sha256').update('challenge').digest());
const CREDENTIAL = b64url(randomBytes(32));
const OTHER_CREDENTIAL = b64url(randomBytes(32));
const USER_ID = b64url(randomBytes(32));

function getOptions(overrides: Record<string, unknown> = {}) {
  return {
    challenge: CHALLENGE,
    rpId: RP_ID,
    allowCredentials: [{ id: CREDENTIAL, type: 'public-key' as const, transports: ['internal' as const, 'hybrid' as const] }],
    userVerification: 'required' as const,
    timeout: 120_000,
    ...overrides,
  };
}

function createOptions(overrides: Record<string, unknown> = {}) {
  return {
    rp: { id: RP_ID, name: 'ANTARA' },
    user: { id: USER_ID, name: 'ANTARA vault 7xKXtg…sAsU', displayName: 'ANTARA vault 7xKXtg…sAsU' },
    challenge: CHALLENGE,
    pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }, { type: 'public-key' as const, alg: -257 }],
    timeout: 120_000,
    excludeCredentials: [{ id: OTHER_CREDENTIAL, type: 'public-key' as const }],
    authenticatorSelection: { residentKey: 'preferred' as const, userVerification: 'required' as const },
    attestation: 'none' as const,
    ...overrides,
  };
}

function clientData(type: string, challenge = CHALLENGE, origin = NATIVE_PASSKEY_ORIGIN, extra: Record<string, unknown> = {}) {
  return b64url(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
}

function authenticatorData(rpId = RP_ID, flags = 0x05) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(7);
  return b64url(Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), counter]));
}

function assertion(overrides: Record<string, unknown> = {}, response: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL,
    rawId: CREDENTIAL,
    type: 'public-key',
    response: { clientDataJSON: clientData('webauthn.get'), authenticatorData: authenticatorData(), signature: b64url(randomBytes(71)), userHandle: null, ...response },
    clientExtensionResults: {},
    ...overrides,
  };
}

function registration(overrides: Record<string, unknown> = {}, response: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL,
    rawId: CREDENTIAL,
    type: 'public-key',
    response: { clientDataJSON: clientData('webauthn.create'), attestationObject: b64url(randomBytes(200)), transports: ['internal', 'hybrid'], ...response },
    clientExtensionResults: {},
    ...overrides,
  };
}

test('passkey get: options map to the narrow Rust request and the assertion comes back as AuthenticationResponseJSON', async () => {
  const answer = assertion();
  await inTauri(answering(answer), async calls => {
    const result = await nativePasskeyGet(getOptions());
    assert.deepEqual(calls, [{ cmd: 'layer_passkey_get', args: { request: { rpId: RP_ID, challenge: CHALLENGE, allowCredentials: [CREDENTIAL], timeoutMs: 120_000 } } }]);
    // userHandle null is omitted, like @simplewebauthn/browser does.
    assert.deepEqual(result, {
      id: CREDENTIAL, rawId: CREDENTIAL, type: 'public-key',
      response: { clientDataJSON: answer.response.clientDataJSON, authenticatorData: answer.response.authenticatorData, signature: answer.response.signature },
      clientExtensionResults: {},
    });
  });
  const handle = b64url(randomBytes(32));
  await inTauri(answering(assertion({}, { userHandle: handle })), async () => {
    assert.equal((await nativePasskeyGet(getOptions({ timeout: undefined }))).response.userHandle, handle);
  });
});

test('passkey get: a malformed request is refused before Windows is asked', async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['missing rpId', { rpId: undefined }],
    ['empty rpId', { rpId: '' }],
    ['uppercase rpId', { rpId: 'ANTARA.TECH' }],
    ['31-byte challenge', { challenge: b64url(randomBytes(31)) }],
    ['33-byte challenge', { challenge: b64url(randomBytes(33)) }],
    ['padded challenge', { challenge: `${CHALLENGE}=` }],
    ['standard base64 challenge', { challenge: `${CHALLENGE.slice(0, 41)}+/` }],
    ['no allowCredentials', { allowCredentials: [] }],
    ['missing allowCredentials', { allowCredentials: undefined }],
    ['short credential id', { allowCredentials: [{ id: b64url(randomBytes(15)), type: 'public-key' }] }],
    ['17 credentials', { allowCredentials: Array.from({ length: 17 }, () => ({ id: b64url(randomBytes(32)), type: 'public-key' })) }],
    ['timeout below range', { timeout: 10_000 }],
    ['timeout above range', { timeout: 200_000 }],
    ['fractional timeout', { timeout: 60_000.5 }],
    ['userVerification preferred', { userVerification: 'preferred' }],
  ];
  for (const [label, overrides] of bad) {
    await inTauri(answering(assertion()), async calls => {
      await rejectsWith(nativePasskeyGet(getOptions(overrides) as never), 'invalid-request', label);
      assert.deepEqual(calls, [], label);
    });
  }
});

test('passkey get: an assertion that does not match the ceremony is refused', async () => {
  const bad: Array<[string, unknown]> = [
    ['other challenge', assertion({}, { clientDataJSON: clientData('webauthn.get', b64url(randomBytes(32))) })],
    ['other origin', assertion({}, { clientDataJSON: clientData('webauthn.get', CHALLENGE, 'https://antara.tech') })],
    ['create type', assertion({}, { clientDataJSON: clientData('webauthn.create') })],
    ['extra clientData field', assertion({}, { clientDataJSON: clientData('webauthn.get', CHALLENGE, NATIVE_PASSKEY_ORIGIN, { tokenBinding: {} }) })],
    ['clientData not JSON', assertion({}, { clientDataJSON: b64url('not json') })],
    ['user not verified', assertion({}, { authenticatorData: authenticatorData(RP_ID, 0x01) })],
    ['user not present', assertion({}, { authenticatorData: authenticatorData(RP_ID, 0x04) })],
    ['other RP ID hash', assertion({}, { authenticatorData: authenticatorData('example.com') })],
    ['short authenticatorData', assertion({}, { authenticatorData: b64url(randomBytes(20)) })],
    ['credential not allowed', assertion({ id: OTHER_CREDENTIAL, rawId: OTHER_CREDENTIAL })],
    ['rawId differs', assertion({ rawId: OTHER_CREDENTIAL })],
    ['wrong type', assertion({ type: 'password' })],
    ['extension results', assertion({ clientExtensionResults: { appid: true } })],
    ['unknown field', assertion({ authenticatorAttachment: 'platform' })],
    ['missing signature', assertion({}, { signature: undefined })],
    ['bad userHandle', assertion({}, { userHandle: '***' })],
    ['null', null],
  ];
  for (const [label, value] of bad) {
    // JSON drops undefined fields, as the IPC would.
    await inTauri(answering(value === null ? null : JSON.parse(JSON.stringify(value))), async () => rejectsWith(nativePasskeyGet(getOptions()), 'passkey-failed', label));
  }
});

test('passkey create: options map to the narrow Rust request and the registration comes back as RegistrationResponseJSON', async () => {
  const answer = registration();
  await inTauri(answering(answer), async calls => {
    const result = await nativePasskeyCreate(createOptions());
    assert.deepEqual(calls, [{
      cmd: 'layer_passkey_create',
      args: {
        request: {
          rpId: RP_ID, rpName: 'ANTARA', challenge: CHALLENGE, userId: USER_ID,
          userName: 'ANTARA vault 7xKXtg…sAsU', userDisplayName: 'ANTARA vault 7xKXtg…sAsU',
          excludeCredentials: [OTHER_CREDENTIAL], timeoutMs: 120_000,
        },
      },
    }]);
    assert.deepEqual(result, {
      id: CREDENTIAL, rawId: CREDENTIAL, type: 'public-key',
      response: { clientDataJSON: answer.response.clientDataJSON, attestationObject: answer.response.attestationObject, transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
    });
  });
  await inTauri(answering(registration({}, { transports: undefined })), async calls => {
    const result = await nativePasskeyCreate(createOptions({ excludeCredentials: undefined }));
    assert.deepEqual((calls[0].args as { request: { excludeCredentials: string[] } }).request.excludeCredentials, []);
    assert.equal('transports' in result.response, false);
  });
  // 128 characters (code points, as the command counts them) is the most the dialog takes.
  const longest = `ANTARA vault ${'\u{1F512}'.repeat(115)}`;
  await inTauri(answering(registration()), async calls => {
    await nativePasskeyCreate(createOptions({ user: { id: USER_ID, name: longest, displayName: longest } }));
    assert.equal((calls[0].args as { request: { userName: string } }).request.userName, longest);
  });
});

test('passkey create: a malformed request is refused before Windows is asked', async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['rp id outside the format', { rp: { id: 'https://antara.tech', name: 'ANTARA' } }],
    ['missing rp', { rp: null }],
    ['empty rp name', { rp: { id: RP_ID, name: ' ' } }],
    ['user id 65 bytes', { user: { id: b64url(randomBytes(65)), name: 'n', displayName: 'd' } }],
    ['empty user name', { user: { id: USER_ID, name: '', displayName: 'd' } }],
    ['129-character display name', { user: { id: USER_ID, name: 'n', displayName: 'd'.repeat(129) } }],
    ['control character in user name', { user: { id: USER_ID, name: 'vault\u0007', displayName: 'd' } }],
    ['newline in rp name', { rp: { id: RP_ID, name: 'ANTARA\n' } }],
    ['EdDSA only', { pubKeyCredParams: [{ type: 'public-key', alg: -8 }] }],
    ['no algorithms', { pubKeyCredParams: [] }],
    ['direct attestation', { attestation: 'direct' }],
    ['UV preferred', { authenticatorSelection: { userVerification: 'preferred' } }],
    ['short challenge', { challenge: b64url(randomBytes(16)) }],
    ['timeout above range', { timeout: 600_000 }],
    ['bad excluded id', { excludeCredentials: [{ id: 'not base64url!', type: 'public-key' }] }],
  ];
  for (const [label, overrides] of bad) {
    await inTauri(answering(registration()), async calls => {
      await rejectsWith(nativePasskeyCreate(createOptions(overrides) as never), 'invalid-request', label);
      assert.deepEqual(calls, [], label);
    });
  }
});

test('passkey create: a registration that does not match the ceremony is refused', async () => {
  const bad: Array<[string, unknown]> = [
    ['excluded credential', registration({ id: OTHER_CREDENTIAL, rawId: OTHER_CREDENTIAL })],
    ['get type', registration({}, { clientDataJSON: clientData('webauthn.get') })],
    ['other challenge', registration({}, { clientDataJSON: clientData('webauthn.create', b64url(randomBytes(32))) })],
    ['extension origin', registration({}, { clientDataJSON: clientData('webauthn.create', CHALLENGE, 'chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin') })],
    ['unknown transport', registration({}, { transports: ['internal', 'telepathy'] })],
    ['duplicate transport', registration({}, { transports: ['usb', 'usb'] })],
    ['short credential id', registration({ id: b64url(randomBytes(8)), rawId: b64url(randomBytes(8)) })],
    ['missing attestationObject', registration({}, { attestationObject: undefined })],
    ['unknown response field', registration({}, { publicKey: 'x' })],
  ];
  for (const [label, value] of bad) {
    await inTauri(answering(JSON.parse(JSON.stringify(value))), async () => rejectsWith(nativePasskeyCreate(createOptions()), 'passkey-failed', label));
  }
});

// ---- Location settings -----------------------------------------------------------

test('openLocationSettings takes no argument and expects no value back', async () => {
  await inTauri(answering(null), async calls => {
    await openLocationSettings();
    assert.deepEqual(calls, [{ cmd: 'open_location_settings', args: {} }]);
  });
  await inTauri(answering('ms-settings:privacy-location'), async () => rejectsWith(openLocationSettings(), 'location-unavailable'));
  await inTauri(answering('location-unavailable', true), async () => {
    await assert.rejects(openLocationSettings(), (error: unknown) => error instanceof NativeLayerError && /location settings/.test(error.message));
  });
});
