/**
 * Headless end-to-end check of the vault protection layers (docs/VAULT_LAYERS.md): the shipped client flow
 * code (flow.ts, collectors.ts, evidence.ts, deviceKey.ts, api.ts and the strict parsers) talks over real HTTP
 * to the real server routes, guardian service, layer service, policy and file store
 * (server/src/solares/layers/testHarness.ts). Only Privy, the Solana RPC, the clock and the device are faked:
 * - ANTARA Desktop's native commands are a scripted device (location, Wi-Fi, connected Bluetooth devices);
 * - passkeys come from the server's software authenticator (UV on unless a test turns it off);
 * - the observed public IP is set per request with X-Forwarded-For.
 * A guardian vote is a Privy signAndSendTransaction call; `server.sends` counts them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startLayerTestServer, type LayerTestServer } from '../../../server/src/solares/layers/testHarness';
import { createTestAuthenticator, type TestPasskey } from '../../../server/src/solares/layers/testAuthenticator';
import { bluetoothMatchId as serverBluetoothMatchId, webauthnChallenge as serverWebauthnChallenge } from '../../../server/src/solares/layers/digest';
import { PairedVaultApiError, requestGuardianApproval } from '../vaults/pairedApi';
import { fetchVaultLayers } from './api';
import { LayerCollectionError, type LayerPlatform, type NativeBluetoothDevice, type NativeWifiConnection } from './collectors';
import { ensureDeviceKey, memoryDeviceKeyStorage, signDevicePayload, type DeviceKey } from './deviceKey';
import { base64UrlDecode, bluetoothMatchId, buildDevicePayload, fromHex, webauthnChallenge } from './evidence';
import { FIXTURE_BLUETOOTH_MATCH, FIXTURE_DIGEST, FIXTURE_NONCE, FIXTURE_WEBAUTHN_CREATE, FIXTURE_WEBAUTHN_GET } from './testFixtures';
import { beginLayerChange, collectEvidence, finishLayerChange, startReleaseApproval, submitReleaseApproval, type CollectionChoices, type LayerContext } from './flow';
import type { ChangeOp, ReleaseChallenge, VaultLayersView } from './types';

const USER = 'did:privy:alice';
const HOME_IP = '203.0.113.7';
const HOME = { lat: 48.8566, lng: 2.3522 };
const HOME_WIFI: NativeWifiConnection = { ssid: 'Home', ssidHex: '486f6d65', bssid: 'AA:BB:CC:DD:EE:01' };
const PHONE: NativeBluetoothDevice = { id: '001A7DDA7113', name: 'Pixel 9', kind: 'classic' };
const HEADPHONES: NativeBluetoothDevice = { id: 'A1B2C3D4E5F6', name: 'Headphones', kind: 'classic' };
const MINUTES = 60 * 1000;

describe('client fixtures agree with the server’s own digest code', () => {
  it('pins the WebAuthn challenges and the opaque Bluetooth id the browser tests and unit tests rely on', async () => {
    const nonce = base64UrlDecode(FIXTURE_NONCE), digest = fromHex(FIXTURE_DIGEST);
    assert.equal(serverWebauthnChallenge('get', nonce, digest), FIXTURE_WEBAUTHN_GET);
    assert.equal(serverWebauthnChallenge('create', nonce, digest), FIXTURE_WEBAUTHN_CREATE);
    assert.equal(await webauthnChallenge('get', FIXTURE_NONCE, FIXTURE_DIGEST), FIXTURE_WEBAUTHN_GET);
    assert.equal(serverBluetoothMatchId(nonce, PHONE.id), FIXTURE_BLUETOOTH_MATCH);
    assert.equal(await bluetoothMatchId(FIXTURE_NONCE, PHONE.id), FIXTURE_BLUETOOTH_MATCH);
  });
});

describe('vault protection layers end to end (client flow code against the real server routes)', () => {
  let server: LayerTestServer;
  const realFetch = globalThis.fetch;
  // What the scripted desktop reports, and where its requests come from.
  const device = { ip: HOME_IP, session: 'session-a', location: { ...HOME, accuracyM: 30 }, wifi: [HOME_WIFI], bluetooth: [PHONE, HEADPHONES], uv: true };
  const reset = () => Object.assign(device, { ip: HOME_IP, session: 'session-a', location: { ...HOME, accuracyM: 30 }, wifi: [HOME_WIFI], bluetooth: [PHONE, HEADPHONES], uv: true });
  const authenticator = createTestAuthenticator({ rpId: 'localhost', origin: 'https://tauri.localhost' });
  const passkeys = new Map<string, TestPasskey>();
  const keys = memoryDeviceKeyStorage();
  let deviceKey: DeviceKey;
  const platform: LayerPlatform = {
    capabilities: () => ({ surface: 'desktop', passkey: 'native', geolocation: 'native', bluetooth: 'native', wifiRadio: true, ceremonyInline: true }),
    openWalletTab: async () => true,
    native: {
      location: async () => ({ ...device.location, at: server.now() - 1000 }),
      wifiConnections: async () => device.wifi,
      connectedBluetooth: async () => device.bluetooth,
      passkeyGet: async options => {
        const allowed = new Set((options.allowCredentials ?? []).map(item => item.id));
        const passkey = [...passkeys.values()].find(item => allowed.has(item.id));
        if (!passkey) throw new Error('No passkey on this device for this vault.');
        return authenticator.assert(passkey, { challenge: options.challenge, rpId: options.rpId, uv: device.uv }) as unknown as Awaited<ReturnType<LayerPlatform['native']['passkeyGet']>>;
      },
      passkeyCreate: async options => {
        const { response, passkey } = authenticator.register({ challenge: options.challenge, rpId: options.rp.id, counter: 1 });
        passkeys.set(passkey.id, passkey);
        return response as unknown as Awaited<ReturnType<LayerPlatform['native']['passkeyCreate']>>;
      },
      openLocationSettings: async () => undefined,
    },
    browser: {
      geolocation: () => undefined, bluetooth: () => undefined,
      startAuthentication: async () => { throw new Error('Desktop uses the native passkey commands.'); },
      startRegistration: async () => { throw new Error('Desktop uses the native passkey commands.'); },
    },
    now: () => server.now(),
  };
  const getToken = async () => USER;
  let multisig = '';
  const context = (): LayerContext => ({ platform, keys, privyUserId: USER, multisig });

  before(async () => {
    server = await startLayerTestServer();
    multisig = server.keys.multisig;
    // The client calls `${API_URL}/api/solares/paired-vault/...` (API_URL is empty outside Vite); send it to the test server.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Forwarded-For', device.ip);
      headers.set('X-Test-Session', device.session);
      return realFetch(`${server.origin}${String(input).replace(/^https?:\/\/[^/]+/, '')}`, { ...init, headers });
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = realFetch; await server?.close(); });

  const change = async (op: ChangeOp, choices: CollectionChoices = {}) => {
    server.nextRateWindow();
    const challenge = await beginLayerChange(USER, multisig, op);
    return { challenge, result: await finishLayerChange(getToken, op, challenge, context(), choices) };
  };
  const layers = async (): Promise<VaultLayersView> => fetchVaultLayers(USER, multisig);
  const release = (index: bigint, lamports: bigint) => {
    server.setProposal(index, lamports);
    return { asset: 'SOL' as const, amountRaw: lamports.toString(), recipient: server.keys.user };
  };
  /** Asks the guardian without evidence, then begins the layer step (section 12 steps 1 to 3). */
  const verify = async (index: string, onDevice: { asset: 'SOL'; amountRaw: string; recipient: string }): Promise<ReleaseChallenge> => {
    server.nextRateWindow();
    const started = await startReleaseApproval(getToken, multisig, index, async () => onDevice, platform);
    assert.equal(started.kind, 'verify');
    return (started as { kind: 'verify'; challenge: ReleaseChallenge }).challenge;
  };
  const refusal = async (promise: Promise<unknown>) => {
    const failure = await promise.then(() => null, error => error);
    assert.ok(failure instanceof PairedVaultApiError || failure instanceof LayerCollectionError, `expected a refusal, got ${failure}`);
    return failure as PairedVaultApiError | LayerCollectionError;
  };
  const failedLayers = (failure: PairedVaultApiError | LayerCollectionError) =>
    failure instanceof PairedVaultApiError ? (failure.layers ?? []).filter(item => !item.ok).map(item => item.id) : [failure.layer];

  it('activates the vault and enrolls every layer from ANTARA Desktop', async () => {
    const register = await globalThis.fetch('/api/solares/paired-vault/solana/register', {
      method: 'POST', headers: { Authorization: `Bearer ${USER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ multisig }),
    });
    assert.equal(register.status, 200);
    assert.equal((await register.json()).status, 'registered');

    // Releases are paused and nothing but a passkey can be enrolled until the vault has one.
    let view = await layers();
    assert.deepEqual(view.layers.map(layer => [layer.id, layer.status, layer.enforced]), [
      ['bluetooth', 'not-enrolled', false], ['wifi', 'not-enrolled', false], ['biometrics', 'not-enrolled', true], ['geolocation', 'not-enrolled', false],
      // Limits is optional and off by default (owner decision 2026-10-13): no cap until the user sets one.
      ['mfa', 'not-enrolled', false], ['limits', 'not-enrolled', false],
    ]);
    const early = await refusal(beginLayerChange(USER, multisig, { type: 'wifi.add-network', label: 'Home' }));
    assert.match(early.message, /Add a passkey to this vault first/);

    // The first passkey, from the session that activated the vault, applies at once.
    const passkey = await change({ type: 'passkey.add', label: 'Windows Hello' });
    assert.equal(passkey.challenge.class, 'tighten');
    assert.deepEqual(passkey.result, { status: 'applied', configVersion: 1 });

    // Every first item turns its layer on, which is tightening: immediate, with the passkey.
    deviceKey = await ensureDeviceKey(keys, USER, multisig, 'desktop', () => server.now());
    const trusted = await change({ type: 'device.add', label: 'Desktop', surface: 'desktop', publicKeySpki: deviceKey.publicKeySpki }, { candidateKey: deviceKey });
    assert.equal(trusted.challenge.class, 'tighten');
    for (const [op, choices] of [
      [{ type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' }, {}],
      [{ type: 'wifi.add-network', label: 'Home' }, {}],
      [{ type: 'wifi.add-radio', label: 'Home Wi-Fi' }, { wifiConnection: `${HOME_WIFI.ssidHex}/${HOME_WIFI.bssid}` }],
      [{ type: 'wifi.set-mode', mode: 'network+radio' }, {}],
      [{ type: 'bluetooth.add-device', label: 'Phone' }, { bluetoothDevice: PHONE.id }],
      [{ type: 'limits.set', perReleaseRaw: { SOL: '200000000', USDC: '20000000' }, perDayRaw: { SOL: '400000000', USDC: '40000000' } }, {}],
    ] as [ChangeOp, CollectionChoices][]) {
      const { challenge, result } = await change(op, choices);
      assert.equal(challenge.class, 'tighten', op.type);
      assert.equal(result.status, 'applied', op.type);
    }

    view = await layers();
    assert.deepEqual(view.layers.map(layer => [layer.id, layer.status, layer.enforced, layer.kinds]), [
      ['bluetooth', 'enrolled', true, ['device-reported']], ['wifi', 'enrolled', true, ['server-observed', 'device-reported']],
      ['biometrics', 'enrolled', true, ['cryptographic']], ['geolocation', 'enrolled', true, ['device-reported']],
      // MFA is ANTARA's own vault authenticator, off until the user sets it up (server route test: "vault MFA").
      ['mfa', 'not-enrolled', false, ['cryptographic']], ['limits', 'enrolled', true, ['cryptographic']],
    ]);
    assert.deepEqual(view.devices.map(item => [item.keyId, item.surface, item.state]), [[deviceKey.keyId, 'desktop', 'active']]);
    assert.equal(view.network.trusted, true);
    // The status view never returns what ANTARA masks: the place, the full IP, the BSSID or the Bluetooth address.
    const raw = JSON.stringify(view, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    for (const secret of [HOME_IP, HOME_WIFI.bssid, PHONE.id, String(HOME.lat), String(HOME.lng)]) assert.equal(raw.includes(secret), false, secret);
    assert.equal(server.sends.length, 0);
  });

  it('refuses a release when any single layer fails, and the guardian does not vote', async () => {
    const onDevice = release(1n, 100_000_000n);
    const attempt = async (setup: () => void) => {
      // Five failures in 15 minutes lock the vault (section 5.2); each attempt here starts a fresh window.
      server.advance(16 * MINUTES);
      reset(); setup();
      try { return await refusal(verify('1', onDevice).then(challenge => submitReleaseApproval(getToken, challenge, context()))); }
      finally { reset(); }
    };
    // Each layer failing alone: the server refuses that layer, or the device refuses before sending anything.
    assert.deepEqual(failedLayers(await attempt(() => { device.uv = false; })), ['biometrics']);
    assert.deepEqual(failedLayers(await attempt(() => { device.location = { lat: HOME.lat + 0.05, lng: HOME.lng, accuracyM: 30 }; })), ['geolocation']);
    assert.deepEqual(failedLayers(await attempt(() => { device.ip = '198.51.100.9'; })), ['wifi']);
    assert.deepEqual(failedLayers(await attempt(() => { device.wifi = [{ ...HOME_WIFI, bssid: 'AA:BB:CC:DD:EE:99' }]; })), ['wifi']);
    const disconnected = await attempt(() => { device.bluetooth = [HEADPHONES]; });
    assert.ok(disconnected instanceof LayerCollectionError && disconnected.layer === 'bluetooth' && /not connected/.test(disconnected.message));

    // A reading the client would never produce, signed by the trusted key, is still refused by the server.
    server.advance(16 * MINUTES);
    const forged = await verify('1', onDevice);
    const evidence = await collectEvidence(forged, context());
    const payload = JSON.parse(Buffer.from(evidence.device!.payload, 'base64url').toString('utf8'));
    const bluetooth = { ...payload.bluetooth, devices: [{ identifier: HEADPHONES.id, name: HEADPHONES.name }] };
    const resigned = await signDevicePayload(deviceKey, buildDevicePayload({ ...payload, bluetooth }));
    const forgedRefusal = await refusal(requestGuardianApproval(USER, multisig, '1', { challengeId: forged.challengeId, passkey: evidence.passkey, device: resigned }));
    assert.deepEqual(failedLayers(forgedRefusal), ['bluetooth']);

    // Readings signed by a device key that was never trusted for this vault are refused.
    server.advance(16 * MINUTES);
    const stranger = await ensureDeviceKey(memoryDeviceKeyStorage(), USER, multisig, 'desktop', () => server.now());
    const unknown = await verify('1', onDevice);
    const own = await collectEvidence(unknown, context());
    const ownPayload = JSON.parse(Buffer.from(own.device!.payload, 'base64url').toString('utf8'));
    const strangerSigned = await signDevicePayload(stranger, buildDevicePayload({ ...ownPayload, keyId: stranger.keyId }));
    const strangerRefusal = await refusal(requestGuardianApproval(USER, multisig, '1', { challengeId: unknown.challengeId, passkey: own.passkey, device: strangerSigned }));
    assert.equal(strangerRefusal instanceof PairedVaultApiError && strangerRefusal.status, 403);

    // No Privy MFA anywhere (owner decision 2026-10-13): this vault's own authenticator is off, so no code is asked for.
    server.advance(16 * MINUTES);
    const noMfa = await verify('1', onDevice);
    assert.ok(!noMfa.required.some(item => item.id === 'mfa'));

    // Limits: 0.3 SOL is over this vault's own 0.2 SOL per-release limit, so the guardian refuses before any layer step.
    const over = release(2n, 300_000_000n);
    const limits = await refusal(startReleaseApproval(getToken, multisig, '2', async () => over, platform));
    assert.ok(limits instanceof PairedVaultApiError && limits.status >= 400 && limits.code !== 'layers-required');

    assert.equal(server.sends.length, 0);
  });

  it('approves when every layer passes, with exactly one guardian vote, and refuses replayed evidence', async () => {
    server.advance(16 * MINUTES);
    reset();
    const onDevice = release(1n, 100_000_000n);
    const challenge = await verify('1', onDevice);
    assert.deepEqual(challenge.required.map(item => item.id), ['biometrics', 'geolocation', 'wifi', 'bluetooth', 'limits']);
    // The enrolled Desktop Bluetooth device is named only by an opaque id bound to this challenge, never its address.
    const match = challenge.required.find(item => item.id === 'bluetooth')!.match;
    assert.equal(match.length, 1);
    assert.notEqual(match[0].identifier, PHONE.id);
    assert.match(match[0].identifier, /^[0-9A-F]{12}$/);

    const evidence = await collectEvidence(challenge, context());
    // Sent first from another network: the Wi-Fi layer fails and the single-use challenge is spent.
    device.ip = '198.51.100.9';
    assert.deepEqual(failedLayers(await refusal(requestGuardianApproval(USER, multisig, '1', { challengeId: challenge.challengeId, ...evidence }))), ['wifi']);
    // The same evidence again, now from the trusted network: refused, the challenge was used.
    device.ip = HOME_IP;
    const replayed = await refusal(requestGuardianApproval(USER, multisig, '1', { challengeId: challenge.challengeId, ...evidence }));
    assert.ok(replayed instanceof PairedVaultApiError && replayed.code === 'challenge-invalid');
    assert.equal(server.sends.length, 0);

    // A fresh begin and fresh evidence: every layer passes and the guardian votes once.
    const fresh = await verify('1', onDevice);
    const approval = await submitReleaseApproval(getToken, fresh, context());
    assert.deepEqual(approval.status === 'approved' && [approval.asset, approval.amountRaw, approval.recipient], ['SOL', 100_000_000n, server.keys.user]);
    assert.equal(server.sends.length, 1);
    // Asking again for the same release never votes twice.
    const again = await requestGuardianApproval(USER, multisig, '1');
    assert.ok(again.status === 'pending' || again.status === 'already-approved');
    assert.equal(server.sends.length, 1);

    // Replays against another release: the spent challenge is refused, and an old passkey assertion inside a new
    // challenge fails Biometrics (it signed the old challenge).
    const next = release(3n, 100_000_000n);
    const reused = await refusal(requestGuardianApproval(USER, multisig, '3', { challengeId: fresh.challengeId, ...evidence }));
    assert.ok(reused instanceof PairedVaultApiError && reused.code === 'challenge-invalid');
    server.advance(16 * MINUTES);
    const third = await verify('3', next);
    const thirdEvidence = await collectEvidence(third, context());
    const oldPasskey = await refusal(requestGuardianApproval(USER, multisig, '3', { challengeId: third.challengeId, passkey: evidence.passkey, device: thirdEvidence.device }));
    assert.deepEqual(failedLayers(oldPasskey), ['biometrics']);
    assert.equal(server.sends.length, 1);
    // Audit lines never carry readings, addresses or identifiers.
    const audit = JSON.stringify(server.audits);
    for (const secret of [HOME_IP, '198.51.100.9', HOME_WIFI.bssid, HOME_WIFI.ssidHex, PHONE.id, String(HOME.lat)]) assert.equal(audit.includes(secret), false, secret);
  });

  it('applies a loosening at once, but only after every layer that is on passes (no 24-hour wait)', async () => {
    server.advance(16 * MINUTES);
    reset();
    const off: ChangeOp = { type: 'layer.disable', layer: 'geolocation' };
    let view = await layers();
    const geolocation = () => view.layers.find(layer => layer.id === 'geolocation')!;
    // From another network the Wi-Fi layer fails, so nothing changes.
    device.ip = '198.51.100.9';
    const elsewhere = await refusal(change(off));
    assert.ok(failedLayers(elsewhere).includes('wifi'), String(failedLayers(elsewhere)));
    device.ip = HOME_IP;
    view = await layers();
    assert.equal(geolocation().status, 'enrolled');

    const { challenge, result } = await change(off);
    assert.equal(challenge.class, 'loosen');
    assert.equal(challenge.effectiveAt, null);
    // Loosening needs every layer that is on.
    assert.deepEqual([...new Set(challenge.required.map(item => item.id))], ['biometrics', 'geolocation', 'wifi', 'bluetooth']);
    assert.equal(result.status, 'applied');

    // Applied at once: Safe Zones is off, nothing is pending, and the next release no longer needs it.
    view = await layers();
    assert.equal(geolocation().status, 'not-enrolled');
    assert.equal(geolocation().enforced, false);
    assert.deepEqual(view.pending, []);
    const onDevice = release(4n, 100_000_000n);
    assert.ok(!(await verify('4', onDevice)).required.some(item => item.id === 'geolocation'));
    assert.equal(server.sends.length, 1);
  });
});
