/**
 * The real LayerPlatform: desktop native commands (src/platform/native.ts), the
 * surface's capabilities (src/platform/layers.ts) and the browser's own APIs.
 * Tests inject their own LayerPlatform instead.
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { layerCapabilities, openWalletTab } from '../../platform/layers';
import {
  nativeConnectedBluetooth, nativeLocation, nativePasskeyCreate, nativePasskeyGet, nativeWifiConnections, openLocationSettings,
} from '../../platform/native';
import type { LayerPlatform } from './collectors';
import { indexedDbDeviceKeyStorage, type DeviceKeyStorage } from './deviceKey';

type LayerNavigator = Navigator & { bluetooth?: ReturnType<LayerPlatform['browser']['bluetooth']> };
const browserNavigator = (): LayerNavigator | undefined => typeof navigator === 'undefined' ? undefined : navigator as LayerNavigator;

export function defaultLayerPlatform(): LayerPlatform {
  return {
    capabilities: layerCapabilities,
    openWalletTab: route => openWalletTab(route),
    native: {
      wifiConnections: nativeWifiConnections, connectedBluetooth: nativeConnectedBluetooth, location: nativeLocation,
      passkeyGet: nativePasskeyGet, passkeyCreate: nativePasskeyCreate, openLocationSettings,
    },
    browser: {
      geolocation: () => browserNavigator()?.geolocation,
      bluetooth: () => browserNavigator()?.bluetooth,
      startAuthentication: optionsJSON => startAuthentication({ optionsJSON }),
      startRegistration: optionsJSON => startRegistration({ optionsJSON }),
    },
    now: () => Date.now(),
  };
}

let storage: DeviceKeyStorage | null = null;
/** One IndexedDB connection per page. */
export function defaultDeviceKeyStorage(): DeviceKeyStorage {
  storage ??= indexedDbDeviceKeyStorage();
  return storage;
}
