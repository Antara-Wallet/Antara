/**
 * "Turn on" from one click, end to end (owner feedback 2026-10-13): the shipped flow code (setup.ts over flow.ts,
 * collectors.ts, deviceKey.ts and api.ts) against the real server routes, layer service, policy and store
 * (server/src/solares/layers/testHarness.ts). A device that is not trusted yet is trusted inside the same flow; each
 * change still has its own single-use challenge and its own passkey assertion, and nothing the server requires is skipped.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startLayerTestServer, type LayerTestServer } from '../../../server/src/solares/layers/testHarness';
import { createTestAuthenticator, type TestPasskey } from '../../../server/src/solares/layers/testAuthenticator';
import { fetchVaultLayers } from './api';
import { LayerCollectionError, type LayerPlatform } from './collectors';
import { loadDeviceKey, memoryDeviceKeyStorage } from './deviceKey';
import { beginLayerChange, finishLayerChange, type LayerContext } from './flow';
import { completeChange, pauseFor, planSteps, prepareChange, trustThisDevice, type ChangeJob, type FlowDeps } from './setup';
import type { ChangeOp } from './types';

// The harness's only user; each harness instance is its own server, store and vault.
const USER = 'did:privy:alice';
const HOME = { lat: 48.8566, lng: 2.3522 };

describe('turning a layer on from a device that is not trusted yet (client flow against the real server routes)', () => {
  let server: LayerTestServer;
  const realFetch = globalThis.fetch;
  const calls = { passkeyGet: 0, passkeyCreate: 0, location: 0 };
  const authenticator = createTestAuthenticator({ rpId: 'localhost', origin: 'https://tauri.localhost' });
  const passkeys = new Map<string, TestPasskey>();
  const keys = memoryDeviceKeyStorage();
  const platform: LayerPlatform = {
    capabilities: () => ({ surface: 'desktop', passkey: 'native', geolocation: 'native', bluetooth: 'native', wifiRadio: true, ceremonyInline: true }),
    openWalletTab: async () => true,
    native: {
      location: async () => { calls.location += 1; return { ...HOME, accuracyM: 30, at: server.now() - 1000 }; },
      wifiConnections: async () => [], connectedBluetooth: async () => [],
      passkeyGet: async options => {
        calls.passkeyGet += 1;
        const allowed = new Set((options.allowCredentials ?? []).map(item => item.id));
        const passkey = [...passkeys.values()].find(item => allowed.has(item.id));
        if (!passkey) throw new Error('No passkey on this device for this vault.');
        return authenticator.assert(passkey, { challenge: options.challenge, rpId: options.rpId, uv: true }) as unknown as Awaited<ReturnType<LayerPlatform['native']['passkeyGet']>>;
      },
      passkeyCreate: async options => {
        calls.passkeyCreate += 1;
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
  const deps = async (known = true): Promise<FlowDeps> => ({ token: getToken, context: context(), deviceLabel: 'ANTARA Desktop', knownDevices: known ? (await fetchVaultLayers(USER, multisig)).devices : null });
  const reset = () => Object.assign(calls, { passkeyGet: 0, passkeyCreate: 0, location: 0 });

  before(async () => {
    server = await startLayerTestServer();
    multisig = server.keys.multisig;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Forwarded-For', '203.0.113.7');
      headers.set('X-Test-Session', 'session-b');
      return realFetch(`${server.origin}${String(input).replace(/^https?:\/\/[^/]+/, '')}`, { ...init, headers });
    }) as typeof fetch;
    const register = await globalThis.fetch('/api/solares/paired-vault/solana/register', {
      method: 'POST', headers: { Authorization: `Bearer ${USER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ multisig }),
    });
    assert.equal(register.status, 200);
    // Activation's first passkey, from the session that registered the vault.
    server.nextRateWindow();
    const op: ChangeOp = { type: 'passkey.add', label: 'Windows Hello' };
    const challenge = await beginLayerChange(USER, multisig, op);
    assert.deepEqual(await finishLayerChange(getToken, op, challenge, context()), { status: 'applied', configVersion: 1 });
  });
  after(async () => { globalThis.fetch = realFetch; await server?.close(); });

  it('Turn on Safe Zones: trusts this device first, then reads the location once; two passkey prompts, nothing else', async () => {
    reset();
    assert.equal(await loadDeviceKey(keys, USER, multisig), null);
    const zone: ChangeJob = { kind: 'change', op: { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' }, title: 'Turn on Safe Zones', waive: [] };
    assert.deepEqual(planSteps(zone, true, 'desktop').map(step => step.label), ['Set up this computer', 'Share your location', 'Confirm with your passkey']);

    server.nextRateWindow();
    let prepared = await prepareChange(zone, await deps());
    // Trusting this device comes first, in the same flow; nothing was asked of the user yet.
    assert.equal(prepared.draft?.job.kind, 'trust');
    assert.equal(prepared.draft?.op.type, 'device.add');
    assert.equal(prepared.draft?.challenge.class, 'tighten');
    assert.deepEqual(prepared.next, zone);
    assert.deepEqual(calls, { passkeyGet: 0, passkeyCreate: 0, location: 0 });
    assert.equal(pauseFor(prepared.draft!, platform), null);
    assert.equal((await completeChange(prepared.draft!, await deps())).status, 'applied');
    assert.deepEqual(calls, { passkeyGet: 1, passkeyCreate: 0, location: 0 });

    // The change itself, begun again so its challenge lists the new key; no second trust step.
    server.nextRateWindow();
    prepared = await prepareChange(prepared.next!, await deps());
    assert.equal(prepared.draft?.job.kind, 'change');
    assert.equal(prepared.next, null);
    const key = (await loadDeviceKey(keys, USER, multisig))!;
    assert.ok(prepared.draft!.challenge.devices.some(device => device.keyId === key.keyId));
    assert.equal(prepared.draft!.challenge.capture.geo, true);
    assert.equal(pauseFor(prepared.draft!, platform), null);
    assert.equal((await completeChange(prepared.draft!, await deps())).status, 'applied');
    assert.deepEqual(calls, { passkeyGet: 2, passkeyCreate: 0, location: 1 });

    const view = await fetchVaultLayers(USER, multisig);
    assert.equal(view.layers.find(layer => layer.id === 'geolocation')!.status, 'enrolled');
    assert.deepEqual(view.devices.map(device => [device.keyId, device.surface, device.state]), [[key.keyId, 'desktop', 'active']]);
  });

  it('adding another zone from the now-trusted device asks for no trust step and still needs every layer that is on', async () => {
    reset();
    server.nextRateWindow();
    const office: ChangeJob = { kind: 'change', op: { type: 'geolocation.add-zone', label: 'Office', radiusM: 1000, center: 'current' }, title: 'Add a safe zone', waive: [] };
    const prepared = await prepareChange(office, await deps());
    assert.equal(prepared.draft?.job.kind, 'change');
    // Adding to a layer that is on loosens it: the server asks for the passkey and a location inside a zone.
    assert.equal(prepared.draft?.challenge.class, 'loosen');
    assert.deepEqual([...new Set(prepared.draft!.challenge.required.map(item => item.id))], ['biometrics', 'geolocation']);
    assert.equal((await completeChange(prepared.draft!, await deps())).status, 'applied');
    assert.deepEqual(calls, { passkeyGet: 1, passkeyCreate: 0, location: 1 });
  });

  it('a stale view that thinks this device is untrusted costs no extra prompt: the server’s answer wins', async () => {
    reset();
    server.nextRateWindow();
    const job: ChangeJob = { kind: 'change', op: { type: 'geolocation.add-zone', label: 'Cabin', radiusM: 5000, center: { lat: 45.9, lng: 6.87 } }, title: 'Add a safe zone', waive: [] };
    const stale: FlowDeps = { ...(await deps(false)), knownDevices: [] };
    const prepared = await prepareChange(job, stale);
    assert.equal(prepared.draft?.job.kind, 'change');
    assert.equal(prepared.next, null);
    assert.deepEqual(calls, { passkeyGet: 0, passkeyCreate: 0, location: 0 });
  });

  it('a change that does not read from this device never sets an untrusted app up unannounced: it stops before any prompt', async () => {
    reset();
    server.nextRateWindow();
    // Another app (its own key storage, never trusted) turns Safe Zones off: the server asks for a location reading.
    const other = { ...(await deps()), context: { ...context(), keys: memoryDeviceKeyStorage() } };
    const off: ChangeJob = { kind: 'change', op: { type: 'layer.disable', layer: 'geolocation' }, title: 'Turn off Safe Zones', waive: [] };
    await assert.rejects(prepareChange(off, other), (error: unknown) => error instanceof LayerCollectionError && error.action === 'add-device' && /Set up this computer first/.test(error.message));
    assert.deepEqual(calls, { passkeyGet: 0, passkeyCreate: 0, location: 0 });
    // Nothing was trusted on the way, and Safe Zones is still on.
    const view = await fetchVaultLayers(USER, multisig);
    assert.equal(view.devices.length, 1);
    assert.equal(view.layers.find(layer => layer.id === 'geolocation')!.status, 'enrolled');
  });

  it('trusting this device right after the first passkey (activation) applies at once, and is skipped when already done', async () => {
    reset();
    server.nextRateWindow();
    // This vault already trusts this device: nothing to do and no prompt.
    assert.equal(await trustThisDevice(await deps()), null);
    assert.deepEqual(calls, { passkeyGet: 0, passkeyCreate: 0, location: 0 });
    // A second app (its own key storage) is trusted with one passkey prompt; the server still checks every layer that is on.
    const other = { ...(await deps()), context: { ...context(), keys: memoryDeviceKeyStorage() } };
    server.nextRateWindow();
    const result = await trustThisDevice(other);
    assert.equal(result?.status, 'applied');
    assert.deepEqual(calls, { passkeyGet: 1, passkeyCreate: 0, location: 1 });
    assert.equal((await fetchVaultLayers(USER, multisig)).devices.length, 2);
  });
});
