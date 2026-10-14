/** Test-only LayerPlatform: every native or browser call fails unless a test provides it. Never import from application code. */
import type { LayerPlatform } from './collectors';
import type { LayerCapabilities } from './types';

/** What the src/platform/native.ts wrappers throw: an error carrying one of the section 10 codes. */
export class FakeNativeError extends Error { constructor(readonly code: string) { super(code); } }

export type FakePlatformOverrides = { capabilities?: Partial<LayerCapabilities>; native?: Partial<LayerPlatform['native']>; browser?: Partial<LayerPlatform['browser']> };
export function fakePlatform(overrides: FakePlatformOverrides = {}, calls: string[] = []): LayerPlatform {
  const unexpected = (name: string) => async () => { calls.push(name); throw new Error(`unexpected ${name}`); };
  return {
    capabilities: () => ({ surface: 'desktop', passkey: 'native', geolocation: 'native', bluetooth: 'native', wifiRadio: true, ceremonyInline: true, ...overrides.capabilities }),
    openWalletTab: async () => true,
    native: {
      wifiConnections: unexpected('wifi'), connectedBluetooth: unexpected('bluetooth'), location: unexpected('location'),
      passkeyGet: unexpected('passkeyGet'), passkeyCreate: unexpected('passkeyCreate'), openLocationSettings: async () => undefined, ...overrides.native,
    },
    browser: {
      geolocation: () => undefined, bluetooth: () => undefined, startAuthentication: unexpected('startAuthentication'), startRegistration: unexpected('startRegistration'), ...overrides.browser,
    },
    now: () => 1_791_892_800_000,
  };
}
