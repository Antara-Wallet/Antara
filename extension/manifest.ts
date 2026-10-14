// Builds the ANTARA Chrome MV3 manifest. Used by vite.extension.config.ts; the
// policy values come from extension/policy.mjs, which scripts/extension-check.mjs
// also enforces. M1 is a standalone wallet: no content scripts, no dApp injection,
// no externally_connectable surface. The only host permission is ANTARA's own API
// (plus the local API server in development builds); it also lets the pages use
// the antara.tech passkey RP ID for the vault Biometrics layer (Chrome 122+).
import extensionKey from './extension-key.json';
import {
  EXTENSION_CSP, EXTENSION_DEV_HOST_PERMISSIONS, EXTENSION_HOST_PERMISSIONS, EXTENSION_PERMISSIONS, MINIMUM_CHROME_VERSION, hostPermissionsFor,
} from './policy.mjs';

export const EXTENSION_ID = extensionKey.id;
export const EXTENSION_PUBLIC_KEY = extensionKey.key;
export { EXTENSION_CSP, EXTENSION_DEV_HOST_PERMISSIONS, EXTENSION_HOST_PERMISSIONS, EXTENSION_PERMISSIONS, MINIMUM_CHROME_VERSION, hostPermissionsFor };
export const ICON_SIZES = [16, 32, 48, 128] as const;

export type ManifestOptions = {
  version: string;
  development: boolean;
};

/** Chrome accepts 1-4 dot-separated integers; keep any prerelease tag as version_name. */
export function chromeVersion(packageVersion: string): { version: string; version_name?: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/.exec(packageVersion.trim());
  if (!match) throw new Error(`package.json version "${packageVersion}" cannot be mapped to a Chrome version.`);
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  return match[4] ? { version, version_name: packageVersion } : { version };
}

export function createManifest(options: ManifestOptions) {
  const icons = Object.fromEntries(ICON_SIZES.map(size => [String(size), `icons/icon-${size}.png`]));
  const hosts = hostPermissionsFor(options.development);
  return {
    manifest_version: 3,
    name: options.development ? 'ANTARA (dev)' : 'ANTARA',
    short_name: 'ANTARA',
    description: 'ANTARA wallet for Solana, Ethereum, BNB Smart Chain, Robinhood Chain and Base in the Chrome side panel.',
    ...chromeVersion(options.version),
    // 122: extension pages may claim a host-permission site's WebAuthn RP ID (vault passkeys).
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    // Development ID for unpacked loads. scripts/extension-package.mjs removes it
    // from the Chrome Web Store upload (see extension/EXTENSION_ID.md).
    key: EXTENSION_PUBLIC_KEY,
    icons,
    // No default_popup: an action popup closes when it loses focus, which breaks
    // email OTP and MFA entry. The service worker sets openPanelOnActionClick, so
    // the toolbar icon opens the side panel directly.
    action: { default_title: 'Open ANTARA', default_icon: { 16: icons['16'], 32: icons['32'] } },
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: [...EXTENSION_PERMISSIONS],
    ...(hosts.length ? { host_permissions: [...hosts] } : {}),
    content_security_policy: { extension_pages: EXTENSION_CSP },
  };
}
