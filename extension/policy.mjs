// Single source of the ANTARA extension's security policy. Imported by the build
// (vite.extension.config.ts via extension/manifest.ts), the package check
// (scripts/extension-check.mjs) and the headless tests, so they cannot drift.

/**
 * extension_pages CSP. No 'wasm-unsafe-eval' (the bundle has no WebAssembly; the
 * check fails if that changes). frame-src is limited to Privy's embedded-wallet
 * iframe and WalletConnect's Verify iframe.
 */
export const EXTENSION_CSP = "script-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src https://auth.privy.io https://verify.walletconnect.org https://verify.walletconnect.com;";

/**
 * Only what the code uses; the manifest must list exactly these (scripts/extension-check.mjs).
 * - sidePanel: the wallet's primary surface.
 * - geolocation: the paired-vault Safe Zones layer (docs/VAULT_LAYERS.md §2e, owner
 *   decision O2). Without it navigator.geolocation fails immediately in extension
 *   pages. Chrome does not allow it as an optional permission, it skips the site
 *   prompt, and it shows the install warning "Detect your physical location".
 *   The pages read a position only inside a vault-layer ceremony the user started:
 *   the package check counts the position calls in the built code and fails on more
 *   than GEOLOCATION_CALL_SITES (ANTARA's collector, src/solares/layers/collectors.ts)
 *   or on any watchPosition, so a dependency update cannot read location silently.
 * Add "storage" only together with real chrome.storage code.
 */
export const EXTENSION_PERMISSIONS = Object.freeze(['sidePanel', 'geolocation']);

/** Expected getCurrentPosition call sites in a built package (the vault Safe Zones collector only). */
export const GEOLOCATION_CALL_SITES = 1;

/**
 * Chrome 122 lets extension pages use the WebAuthn RP ID of a site they have host
 * permission for, so the vault Biometrics passkey (rpId PASSKEY_RP_ID) works from
 * the extension (docs/VAULT_LAYERS.md §2b). 116 was needed for chrome.sidePanel.open.
 */
export const MINIMUM_CHROME_VERSION = '122';

/** Production ANTARA API origin. Production extension builds use it when VITE_API_BASE is unset. */
export const PRODUCTION_API_BASE = 'https://antara.tech';

/**
 * WebAuthn relying party of the vault Biometrics layer on every surface. The
 * extension may claim it only while it holds host permission for this site, so
 * the check fails if no host permission covers it. If a user withdraws site
 * access in Chrome, passkey ceremonies are expected to fail, which keeps the layer
 * closed; that is not verified yet (docs/VAULT_LAYERS.md §15, extension checks).
 */
export const PASSKEY_RP_ID = 'antara.tech';

/**
 * Committed host allowlist: only ANTARA's own production API, so wallet API calls
 * do not depend on the server's CORS list. Third-party origins stay CORS-only
 * (CORS_ORIGINS below): each one answered CORS for the chrome-extension:// origin
 * on 2026-10-12, and a new host in an update would disable the extension until
 * users re-approve it. The build and the check fail if the generated manifest
 * differs from this list (production) or EXTENSION_DEV_HOST_PERMISSIONS (dev).
 */
export const EXTENSION_HOST_PERMISSIONS = Object.freeze([`${PRODUCTION_API_BASE}/*`]);

/** Development builds ("ANTARA (dev)") may also reach the local API server. Never shipped. */
export const DEV_API_HOST_PERMISSIONS = Object.freeze(['http://localhost:8787/*', 'http://127.0.0.1:8787/*']);
export const EXTENSION_DEV_HOST_PERMISSIONS = Object.freeze([...EXTENSION_HOST_PERMISSIONS, ...DEV_API_HOST_PERMISSIONS]);

/** Host allowlist for a build type. */
export function hostPermissionsFor(development) {
  return development ? EXTENSION_DEV_HOST_PERMISSIONS : EXTENSION_HOST_PERMISSIONS;
}

/**
 * Third-party origins the wallet pages may contact through CORS (no host
 * permission). Network-registry RPC defaults must be listed here or the build
 * fails, so a new default RPC gets a deliberate CORS review. The ANTARA API needs
 * chrome-extension://<id> in the server's ALLOWED_ORIGINS instead.
 */
export const CORS_ORIGINS = Object.freeze([
  // Privy auth API and embedded-wallet iframe; Privy-hosted Solana RPC.
  'https://auth.privy.io',
  'https://solana-mainnet.rpc.privy.systems',
  'https://solana-devnet.rpc.privy.systems',
  // WalletConnect wallet list that Privy's external-wallet login fetches.
  'https://explorer-api.walletconnect.com',
  // Pinned keyless RPC defaults from src/solares/networks.ts. The official Solana
  // endpoint answers the preflight but refuses (403) any request with an Origin
  // header, so the pages use solana-rpc.publicnode.com (the registry's browser
  // default) and the build refuses api.mainnet-beta.solana.com as an override.
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://api.devnet.solana.com',
  'https://ethereum-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
  'https://mainnet.base.org',
]);

/** Origins extension pages may frame (mirrors frame-src above). */
export const FRAME_ORIGINS = Object.freeze(['https://auth.privy.io', 'https://verify.walletconnect.org', 'https://verify.walletconnect.com']);

/** Privy app IDs are 25 alphanumeric characters; PrivyProvider throws on anything else. */
export const PRIVY_APP_ID_FORMAT = /^[a-z0-9]{25}$/i;

/** Privy app client IDs (Dashboard > Clients) are public and start with "client-". */
export const PRIVY_CLIENT_ID_FORMAT = /^client-[A-Za-z0-9]{20,64}$/;

/**
 * Vite inlines every VITE_ value into the bundle. A name that looks like a
 * credential fails the build and the check unless it is listed in
 * PUBLIC_ENV_NAMES after confirming its value is public.
 */
export const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PRIVATE|PASSWORD|PASSPHRASE|MNEMONIC|SEED|BEARER|SIGNING|CREDENTIAL|JWT)/i;
export const PUBLIC_ENV_NAMES = Object.freeze(new Set([]));

export function isSecretEnvName(name) {
  return SECRET_ENV_NAME.test(name) && !PUBLIC_ENV_NAMES.has(name);
}

const KEY_LIKE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const CREDENTIAL_PARAM = /^(api[-_]?key|apikey|key|access[-_]?token|auth[-_]?token|token|secret|password)$/i;

/**
 * Why a public URL must not be bundled: credentials, a key-like path segment
 * (Alchemy /v2/<key>, Infura /v3/<key>, QuickNode /<token>/) or a credential query
 * parameter. strict (RPC/WebSocket/API URLs) also rejects any query or fragment,
 * mirroring the parts the server's urlSecrets() treats as secret.
 */
export function urlSecretProblems(value, { strict = true } = {}) {
  let url;
  try { url = new URL(value); } catch { return ['it is not an absolute URL']; }
  const problems = [];
  if (url.username || url.password) problems.push('credentials');
  const segments = url.pathname.split('/').map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments.some(segment => KEY_LIKE_SEGMENT.test(segment))) problems.push('a key-like path segment');
  if ([...url.searchParams.keys()].some(name => CREDENTIAL_PARAM.test(name))) problems.push('a credential query parameter');
  else if (strict && url.search) problems.push('a query string');
  if (strict && url.hash) problems.push('a fragment');
  return problems;
}
