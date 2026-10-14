// What vault-layer evidence this surface can collect (docs/VAULT_LAYERS.md §11).
// A capability only says that an API exists here. It never says a layer is
// enrolled, enforced or passed: only the server's GET /solana/layers answer can.
// Everything unknown resolves to 'none' or false, so a missing API fails closed.
import { detectRuntime, extensionSurface, extensionUrl } from './index';

export type LayerSurface = 'desktop' | 'extension' | 'web';

export interface LayerCapabilities {
  surface: LayerSurface;
  /** desktop on Windows: webauthn.dll through layer_passkey_*; extension/web: navigator.credentials. */
  passkey: 'native' | 'browser' | 'none';
  /** desktop on Windows: layer_location (WinRT); extension/web: navigator.geolocation. */
  geolocation: 'native' | 'browser' | 'none';
  /** desktop on Windows: connected classic devices; extension/web: Web Bluetooth requestDevice(). */
  bluetooth: 'native' | 'web-bluetooth' | 'none';
  /** Connected Wi-Fi name and access point: ANTARA Desktop on Windows only. */
  wifiRadio: boolean;
  /**
   * Whether passkey, Bluetooth-chooser and location ceremonies run in this page.
   * False in the extension side panel (and any extension page other than the full
   * tab) until those prompts are verified there on real Chrome; callers hand off
   * with openWalletTab('#vault') instead.
   */
  ceremonyInline: boolean;
}

type LayerNavigator = {
  userAgent?: string;
  credentials?: { get?: unknown; create?: unknown };
  geolocation?: { getCurrentPosition?: unknown };
  bluetooth?: { requestDevice?: unknown };
};

function layerNavigator(): LayerNavigator | undefined {
  return (globalThis as { navigator?: LayerNavigator }).navigator;
}

/** WebAuthn and Web Bluetooth exist only in secure contexts; geolocation fails outside one. */
function secureContext(): boolean {
  return (globalThis as { isSecureContext?: unknown }).isSecureContext === true;
}

function browserPasskey(): boolean {
  const credentials = layerNavigator()?.credentials;
  return secureContext()
    && typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === 'function'
    && typeof credentials?.get === 'function'
    && typeof credentials.create === 'function';
}

function browserGeolocation(): boolean {
  return secureContext() && typeof layerNavigator()?.geolocation?.getCurrentPosition === 'function';
}

function webBluetooth(): boolean {
  return secureContext() && typeof layerNavigator()?.bluetooth?.requestDevice === 'function';
}

/** The layer_* commands are implemented for Windows only; other desktop builds answer unsupported-platform. */
function windowsDesktop(): boolean {
  return /\bWindows\b/.test(layerNavigator()?.userAgent ?? '');
}

export function layerCapabilities(): LayerCapabilities {
  const runtime = detectRuntime();
  if (runtime === 'tauri') {
    // WebView2 has no working WebAuthn prompt or Bluetooth chooser (§2a, §2d), so the
    // desktop never falls back to the browser APIs.
    const windows = windowsDesktop();
    return {
      surface: 'desktop',
      passkey: windows ? 'native' : 'none',
      geolocation: windows ? 'native' : 'none',
      bluetooth: windows ? 'native' : 'none',
      wifiRadio: windows,
      ceremonyInline: true,
    };
  }
  const browser = {
    passkey: browserPasskey() ? 'browser' as const : 'none' as const,
    geolocation: browserGeolocation() ? 'browser' as const : 'none' as const,
    bluetooth: webBluetooth() ? 'web-bluetooth' as const : 'none' as const,
    wifiRadio: false,
  };
  if (runtime === 'extension') return { surface: 'extension', ...browser, ceremonyInline: extensionSurface() === 'tab' };
  return { surface: 'web', ...browser, ceremonyInline: true };
}

// Only the wallet's own short page anchors (#portfolio, #vault, ...).
const WALLET_ROUTE = /^#[a-z]{1,24}$/i;

export function isWalletRoute(value: string): value is `#${string}` {
  return WALLET_ROUTE.test(value);
}

type TabsChrome = { tabs?: { create?: (options: { url: string; active?: boolean }) => Promise<unknown> } };

/**
 * Extension only: shows the wallet (at `route`, e.g. '#vault') in a full browser tab.
 * - From the side panel (or a popup): opens wallet.html<route> in a new active tab,
 *   then closes the panel, so two pages never refresh the same Privy session at once.
 *   This is the side panel's "Open in full tab" behaviour.
 * - Already in the full tab: moves this page to <route> instead of opening a second one.
 * Resolves false outside the extension or when Chrome's tabs API is missing. Rejects
 * when Chrome does not open the tab, or for anything but a short wallet anchor.
 */
export async function openWalletTab(route?: `#${string}`): Promise<boolean> {
  if (route !== undefined && !isWalletRoute(route)) throw new Error('Only wallet page anchors such as #vault can be opened.');
  if (detectRuntime() !== 'extension') return false;
  const surface = extensionSurface();
  if (surface === 'tab') {
    if (route && location.hash !== route) location.hash = route;
    return true;
  }
  const url = extensionUrl(`wallet.html${route ?? ''}`);
  const tabs = (globalThis as { chrome?: TabsChrome }).chrome?.tabs;
  if (!url || typeof tabs?.create !== 'function') return false;
  await tabs.create({ url, active: true });
  if ((surface === 'sidepanel' || surface === 'popup') && typeof window !== 'undefined') window.close();
  return true;
}
