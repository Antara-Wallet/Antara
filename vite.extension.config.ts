// Chrome MV3 extension build for ANTARA (milestone M1: standalone wallet).
//
//   npm run build:extension       production: VITE_API_BASE defaults to https://antara.tech
//                                 and must be https (never a local API)
//   npm run build:extension:dev   development: VITE_API_BASE defaults to http://localhost:8787
//   --mode extension-test         hermetic test build (scripts/extension-test.mjs): reads no
//                                 .env files and writes to ANTARA_EXTENSION_OUT_DIR
//
// Output: dist-extension/ with sidepanel.html (main wallet; the toolbar icon opens
// it directly), wallet.html (the same wallet in a full tab), background.js (module
// service worker that holds no keys or tokens) and manifest.json. There is no
// action popup: it closes on focus loss and would break email OTP. The pages mount
// the same WalletApp as the desktop/browser app. Captcha, Telegram-widget and Stripe-onramp loaders are
// replaced so no remotely hosted code is bundled (Chrome Web Store policy).
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import pngjs from 'pngjs';

const { PNG } = pngjs;
type Png = InstanceType<typeof PNG>;
import { BROWSER_REFUSED_RPC_HOSTS, SOLANA_DEVNET_RPC_URL, SUPPORTED_NETWORKS, rpcUrlFor } from './src/solares/networks';
import { createManifest, ICON_SIZES } from './extension/manifest';
import {
  CORS_ORIGINS, MINIMUM_CHROME_VERSION, PRIVY_APP_ID_FORMAT, PRIVY_CLIENT_ID_FORMAT, PRODUCTION_API_BASE, hostPermissionsFor, isSecretEnvName, urlSecretProblems,
} from './extension/policy.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const MODES = {
  extension: { development: false, hermetic: false },
  'extension-dev': { development: true, hermetic: false },
  // Tests: no .env files, so the variant is decided only by the variables the test runner passes.
  'extension-test': { development: true, hermetic: true },
} as const;
const DEV_API = 'http://localhost:8787';
const LOCAL_DEV_HOSTS = new Set(['localhost:8787', '127.0.0.1:8787']);

function fail(message: string): never {
  throw new Error(`[extension build] ${message}`);
}

function validateApiBase(raw: string | undefined, development: boolean): string {
  const value = (raw ?? '').trim() || (development ? DEV_API : PRODUCTION_API_BASE);
  let url: URL;
  try { url = new URL(value); } catch { fail(`VITE_API_BASE "${value}" is not an absolute URL.`); }
  if (url.username || url.password || url.search || url.hash) fail('VITE_API_BASE must not contain credentials, a query or a fragment.');
  const localDev = url.protocol === 'http:' && LOCAL_DEV_HOSTS.has(url.host);
  if (development) {
    if (url.protocol !== 'https:' && !localDev) fail('Development extension builds accept https:// or http://localhost:8787 only.');
  } else {
    if (url.protocol !== 'https:') fail('Production extension builds require an https:// VITE_API_BASE.');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('Production extension builds must not target a local API.');
  }
  if (url.pathname !== '/') fail('VITE_API_BASE must be an origin without a path (the app adds /api/solares/...).');
  return url.origin;
}

/** Rejects a public URL that would put a credential into the bundle (Vite inlines VITE_ values). */
function assertNoUrlSecret(name: string, value: string, strict: boolean) {
  const problems = urlSecretProblems(value, { strict });
  if (problems.length) fail(`${name} must not contain ${problems.join(', ')}: Vite would inline it into the bundle. Proxy keyed providers through the ANTARA API instead.`);
}

function rpcOrigin(value: string, development: boolean, label: string): string | null {
  const url = new URL(value);
  if (url.protocol === 'https:') return url.origin;
  // An http RPC override is only tolerated for local development nodes.
  if (development && ['localhost', '127.0.0.1'].includes(url.hostname)) return null;
  fail(`${label} must be an https:// RPC URL in extension builds.`);
}

const EXPECTED_NETWORKS = 'base,bsc,ethereum,robinhood,solana';

/**
 * Checks every RPC URL the wallet pages may call: each supported network's pinned
 * keyless defaults plus its public VITE_ override. Defaults must be on the
 * committed CORS list (extension/policy.mjs); overrides must be https and keyless.
 * No URL becomes a host permission, so an override cannot change the manifest.
 */
function checkRpcUrls(env: Record<string, string>, development: boolean): void {
  const keys = SUPPORTED_NETWORKS.map(network => network.key).sort().join(',');
  if (keys !== EXPECTED_NETWORKS) fail(`Network registry changed (${keys}); review extension/policy.mjs CORS_ORIGINS.`);
  const solanaCluster = env.VITE_SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
  const defaults = [...SUPPORTED_NETWORKS.flatMap(network => network.rpc.defaults), SOLANA_DEVNET_RPC_URL];
  const missing = [...new Set(defaults.map(url => new URL(url).origin))].filter(origin => !CORS_ORIGINS.includes(origin));
  if (missing.length) fail(`RPC default(s) ${missing.join(', ')} are not in extension/policy.mjs CORS_ORIGINS. Verify CORS for chrome-extension:// origins, then list them.`);
  for (const network of SUPPORTED_NETWORKS) {
    const name = network.rpc.browserEnv;
    const value = env[name]?.trim();
    if (!value) continue;
    assertNoUrlSecret(name, value, true);
    const origin = rpcOrigin(rpcUrlFor(network, env, 'browser', { solanaCluster }), development, name);
    if (origin && !CORS_ORIGINS.includes(origin)) console.warn(`[extension build] ${name} uses ${origin}; it must answer CORS for chrome-extension:// origins (not verified by the build).`);
  }
  for (const name of ['VITE_SOLANA_RPC_URL', 'VITE_SOLANA_WS_URL']) {
    const value = env[name]?.trim();
    let host = '';
    try { host = value ? new URL(value).hostname.toLowerCase() : ''; } catch { /* reported above or by Vite */ }
    if (BROWSER_REFUSED_RPC_HOSTS.includes(host)) fail(`${name} uses ${host}, which refuses every request carrying an Origin header (HTTP 403), so Solana would fail in the extension. Use an endpoint that accepts browser requests, for example https://solana-rpc.publicnode.com, or leave it empty for that default.`);
  }
}

/** Secret-name and secret-value backstop over every VITE_ variable Vite will inline. */
function checkPublicEnv(env: Record<string, string>): void {
  const secretNames = Object.keys(env).filter(isSecretEnvName);
  if (secretNames.length) fail(`Refusing to bundle secret-looking public variables: ${secretNames.join(', ')}. Only public values may use the VITE_ prefix (allowlist: PUBLIC_ENV_NAMES in extension/policy.mjs).`);
  for (const [name, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (!value || !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) continue;
    // RPC and WebSocket endpoints must be bare; other public links (community,
    // downloads) may keep a harmless query but never credentials or key-like paths.
    assertNoUrlSecret(name, value, /_(RPC|WS)_URL$/.test(name));
  }
  const appId = env.VITE_PRIVY_APP_ID?.trim();
  if (appId && !PRIVY_APP_ID_FORMAT.test(appId)) fail('VITE_PRIVY_APP_ID is set but is not a 25-character Privy app ID; PrivyProvider would throw and the wallet could not start.');
  const clientId = env.VITE_PRIVY_CLIENT_ID?.trim();
  if (clientId && !PRIVY_CLIENT_ID_FORMAT.test(clientId)) console.warn('[extension build] VITE_PRIVY_CLIENT_ID does not look like a Privy app client ID ("client-..."); check Privy Dashboard > Clients.');
  if (clientId && !appId) fail('VITE_PRIVY_CLIENT_ID is set without VITE_PRIVY_APP_ID.');
}

/** Area-averaged square downscale with premultiplied alpha. */
function resizeIcon(source: Png, size: number): Buffer {
  const out = new PNG({ width: size, height: size });
  const sx = source.width / size;
  const sy = source.height / size;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      const x0 = ox * sx, x1 = x0 + sx, y0 = oy * sy, y1 = y0 + sy;
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
        const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
        for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
          const weight = wy * (Math.min(ix + 1, x1) - Math.max(ix, x0));
          const i = (iy * source.width + ix) * 4;
          const alpha = source.data[i + 3] / 255;
          r += source.data[i] * alpha * weight;
          g += source.data[i + 1] * alpha * weight;
          b += source.data[i + 2] * alpha * weight;
          a += alpha * weight;
          w += weight;
        }
      }
      const o = (oy * size + ox) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round((a / w) * 255);
    }
  }
  return PNG.sync.write(out);
}

// Only the artwork the wallet pages use; the landing hero and site-only files stay out.
const PUBLIC_DIRS = ['antara', 'solares'];
const PUBLIC_EXCLUDE = new Set(['antara/landing-guardian.png']);
// Provenance and generation notes stay in the repository, not in the package.
const NON_RUNTIME_FILE = /(\.txt$|provenance[^/]*\.json$)/i;

function publicFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? publicFiles(path) : [path];
  });
}

/** Emits manifest.json, icons and wallet artwork, and moves extension/*.html to the output root. */
function extensionPackage(manifest: ReturnType<typeof createManifest>): Plugin {
  return {
    name: 'antara-extension-package',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        const page = /^extension\/([a-z-]+\.html)$/.exec(fileName);
        if (!page || output.type !== 'asset') continue;
        delete bundle[fileName];
        const source = String(output.source).replace(/((?:src|href)=["'])\.\.\//g, '$1./');
        bundle[page[1]] = { ...output, fileName: page[1], source };
      }
      for (const page of ['sidepanel.html', 'wallet.html']) {
        if (!bundle[page]) this.error(`Missing extension page ${page}.`);
      }
      if (!bundle['background.js']) this.error('Missing background.js service worker.');
      const icon = PNG.sync.read(readFileSync(resolve(root, 'public/antara/app-icon-512.png')));
      for (const size of ICON_SIZES) this.emitFile({ type: 'asset', fileName: `icons/icon-${size}.png`, source: resizeIcon(icon, size) });
      for (const dir of PUBLIC_DIRS) {
        for (const file of publicFiles(resolve(root, 'public', dir))) {
          const fileName = relative(resolve(root, 'public'), file).split('\\').join('/');
          if (!PUBLIC_EXCLUDE.has(fileName) && !NON_RUNTIME_FILE.test(fileName)) this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
        }
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
    },
  };
}

/**
 * Privy injects `<origin>/js/telegram-login.js` when Telegram login is enabled for
 * the app. Extension pages cannot run remote scripts (and the Web Store forbids
 * them), so the loader is neutralised; Telegram login must stay disabled for the
 * extension's Privy client. Fails the build if the SDK pattern changes.
 */
function noTelegramWidget(): Plugin {
  return {
    name: 'antara-extension-no-telegram-widget',
    transform(code, id) {
      if (!id.includes('@privy-io') || !code.includes('telegram-login.js')) return null;
      const next = code.replace(/([\w$]+)\.src=`\$\{[\w$]+\}\/js\/telegram-login\.js`/g, '$1.src=""');
      if (next === code || next.includes('telegram-login.js')) this.error(`Privy's Telegram widget loader changed in ${id}; update the extension guard.`);
      return { code: next, map: null };
    },
  };
}

/** Output directory: dist-extension, or a dist-extension-test/<variant> folder for hermetic test builds. */
function outputDir(hermetic: boolean): string {
  if (!hermetic) return resolve(root, 'dist-extension');
  const out = resolve(root, process.env.ANTARA_EXTENSION_OUT_DIR || 'dist-extension-test/default');
  if (!out.startsWith(resolve(root, 'dist-extension-test') + sep)) fail('ANTARA_EXTENSION_OUT_DIR must be a folder inside dist-extension-test/.');
  return out;
}

export default defineConfig(({ mode }) => {
  if (!(mode in MODES)) fail(`Unknown mode "${mode}". Use --mode extension, extension-dev or extension-test.`);
  const { development, hermetic } = MODES[mode as keyof typeof MODES];
  // A hermetic build reads no .env files (this folder does not exist), only process env.
  const envDir = hermetic ? resolve(root, 'extension/.no-env-files') : root;
  const env = loadEnv(mode, envDir, 'VITE_');
  checkPublicEnv(env);
  const apiBase = validateApiBase(env.VITE_API_BASE, development);
  // Shell variables outrank .env files in Vite; this pins the validated value.
  process.env.VITE_API_BASE = apiBase;
  const apiHosts = hostPermissionsFor(development);
  if (!apiHosts.includes(`${apiBase}/*`)) console.warn(`[extension build] API ${apiBase} is outside host_permissions: its ALLOWED_ORIGINS must include chrome-extension://<extension id>.`);
  console.log(`[extension build] ${development ? 'development' : 'production'} build, API ${apiBase}`);
  checkRpcUrls(env, development);
  if (!env.VITE_PRIVY_APP_ID) console.warn('[extension build] VITE_PRIVY_APP_ID is empty: the extension will show the disconnected wallet only.');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const manifest = createManifest({ version: pkg.version, development });
  const hosts = (manifest as { host_permissions?: string[] }).host_permissions ?? [];
  if (JSON.stringify(hosts) !== JSON.stringify(apiHosts)) fail('Generated host_permissions differ from the committed allowlist in extension/policy.mjs.');
  const stubs = resolve(root, 'src/extension/stubs');

  return {
    root,
    base: './',
    envDir,
    publicDir: resolve(root, 'public'),
    clearScreen: false,
    plugins: [
      react(),
      tailwindcss(),
      nodePolyfills({ include: ['buffer', 'process', 'events', 'util', 'stream'], globals: { Buffer: true, global: true, process: true } }),
      noTelegramWidget(),
      extensionPackage(manifest),
    ],
    resolve: {
      alias: [
        { find: /^@marsidev\/react-turnstile$/, replacement: resolve(stubs, 'turnstile.tsx') },
        { find: /^@hcaptcha\/react-hcaptcha$/, replacement: resolve(stubs, 'hcaptcha.tsx') },
        { find: /^@stripe\/crypto$/, replacement: resolve(stubs, 'stripe-crypto.ts') },
      ],
    },
    build: {
      outDir: outputDir(hermetic),
      emptyOutDir: true,
      // Public files resolve at build time; extensionPackage copies only the wallet artwork.
      copyPublicDir: false,
      // Same floor as the manifest's minimum_chrome_version (extension/policy.mjs).
      target: `chrome${MINIMUM_CHROME_VERSION}`,
      sourcemap: false,
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        input: {
          sidepanel: resolve(root, 'extension/sidepanel.html'),
          wallet: resolve(root, 'extension/wallet.html'),
          background: resolve(root, 'src/extension/background.ts'),
        },
        output: {
          entryFileNames: chunk => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
