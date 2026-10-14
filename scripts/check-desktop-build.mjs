#!/usr/bin/env node
// Validates the ANTARA desktop (Tauri) security configuration and, with
// --installer, the production frontend build that `tauri build` packages.
// Exits non-zero on any problem.
//
//   node scripts/check-desktop-build.mjs                          configuration only
//   node scripts/check-desktop-build.mjs --installer [--dir dist] configuration + built frontend
//
// src-tauri/tauri.conf.json runs the --installer form in beforeBuildCommand, right
// after `npm run build:app`, so an installer cannot be bundled from a frontend
// built without an https VITE_API_BASE. VITE_API_BASE resolves exactly as Vite's
// production build resolves it (shell, then .env.production.local, .env.production,
// .env.local, .env). The only value ever printed is that public API origin.
//
// An installer must use the production API origin (https://antara.tech). A staging
// installer, which must not be distributed, needs ANTARA_DESKTOP_STAGING=1 in the shell.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretEnvName, urlSecretProblems } from '../extension/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');

export const PRODUCTION_API_BASE = 'https://antara.tech';
export const IDENTIFIER = 'app.solares.wallet';
/** Native commands the main webview must never be granted (see the Rust ACL tests in src-tauri/src/browser.rs). */
export const DENIED_COMMANDS = Object.freeze([
  'list_drives',
  'import_account',
  'sign_hash',
  'reveal_mnemonic',
  'reveal_private_key',
  'stealth_sign',
  'webauthn_make_credential',
  'webauthn_get_assertion',
]);
/**
 * Vault-layer commands (docs/VAULT_LAYERS.md §10). The main webview must be granted
 * exactly these, and no other webview may be: they open the OS passkey dialog for
 * antara.tech and read location, Wi-Fi and Bluetooth (mirrors LAYER_COMMANDS in
 * src-tauri/src/browser.rs). The legacy webauthn_* bridge stays in DENIED_COMMANDS.
 */
export const LAYER_COMMANDS = Object.freeze([
  'layer_wifi_connections',
  'layer_bluetooth_connected',
  'layer_location',
  'layer_passkey_get',
  'layer_passkey_create',
  'open_location_settings',
]);
/** Privy CAPTCHA is off; these hosts must not load script, styles or frames next to native IPC. */
export const CAPTCHA_HOSTS = Object.freeze(['challenges.cloudflare.com', 'hcaptcha.com']);
/**
 * The complete frame-src allowlist: every entry is required and nothing else may be framed.
 * Privy frames its embedded wallet from the SDK API origin, https://auth.privy.io, unless the
 * Privy app sets a custom API domain (it did not when checked on October 12, 2026). A new frame
 * origin is a reviewed change, mirrored in server/src/index.ts and extension/policy.mjs.
 */
export const REQUIRED_FRAMES = Object.freeze(['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org']);
/** The local development API on any loopback or unspecified-address spelling. */
export const LOCAL_API = /(?:^|[^\w.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):8787(?!\d)/i;

/** Splits a CSP string into directive name -> source list. */
export function parseCsp(csp) {
  const directives = new Map();
  for (const part of String(csp).split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/** Problems with one Tauri CSP string (production `csp` or `devCsp`). */
export function cspProblems(csp, label = 'csp') {
  if (typeof csp !== 'string' || !csp.trim()) return [`app.security.${label} must be a non-empty CSP string.`];
  const problems = [];
  const directives = parseCsp(csp);
  const lower = csp.toLowerCase();
  for (const host of CAPTCHA_HOSTS) if (lower.includes(host)) problems.push(`${label} still allows the CAPTCHA host ${host}.`);
  if (LOCAL_API.test(lower)) problems.push(`${label} allows the local development API (localhost:8787); packaged builds use the HTTPS API origin.`);
  for (const [name, sources] of directives) {
    for (const source of sources) {
      const local = /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(source);
      if (local) problems.push(`${label} ${name} allows the local origin ${source}.`);
    }
  }
  const same = (name, expected) => {
    const sources = directives.get(name);
    if (!sources) problems.push(`${label} has no ${name} directive.`);
    else if (sources.join(' ') !== expected) problems.push(`${label} ${name} must be exactly "${expected}" (found "${sources.join(' ')}").`);
  };
  same('default-src', "'self'");
  same('script-src', "'self' 'wasm-unsafe-eval'");
  same('style-src', "'self' 'unsafe-inline'");
  same('object-src', "'none'");
  same('base-uri', "'self'");
  const frames = directives.get('frame-src') ?? [];
  for (const frame of REQUIRED_FRAMES) if (!frames.includes(frame)) problems.push(`${label} frame-src must include ${frame}.`);
  for (const frame of frames) if (!REQUIRED_FRAMES.includes(frame)) problems.push(`${label} frame-src source ${frame} is not in the reviewed frame allowlist.`);
  const connect = directives.get('connect-src') ?? [];
  for (const source of connect) if (/^http:/i.test(source) && source !== 'http://ipc.localhost') problems.push(`${label} connect-src allows plain HTTP ${source}.`);
  return problems;
}

/** Permission identifiers and command names a capability grants, including `allow` rules inside object entries. */
function grantedPermissions(capability) {
  return new Set((capability?.permissions ?? []).flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    return [entry?.identifier, ...(entry?.allow ?? []).flatMap(rule => Object.values(rule ?? {}))].filter(value => typeof value === 'string');
  }));
}

const grants = (granted, command) => granted.has(`allow-${command.replaceAll('_', '-')}`) || granted.has(command);

/** True unless the capability applies to the "main" webview only: no windows (child webviews would inherit) and no remote origins. */
function reachesBeyondMain(capability) {
  if (JSON.stringify(capability?.webviews) !== '["main"]') return true;
  if (Array.isArray(capability.windows) ? capability.windows.length : capability.windows !== undefined) return true;
  return capability.remote !== undefined && capability.remote !== null;
}

/** Command names enrolled in src-tauri/build.rs (`AppManifest::commands`), or null when the list cannot be read. */
export function buildCommands(source) {
  const block = /\.commands\(&\[([\s\S]*?)\]\)/.exec(String(source ?? ''))?.[1];
  const commands = block ? [...block.matchAll(/"([a-z][a-z0-9_]*)"/g)].map(match => match[1]) : [];
  return commands.length ? commands : null;
}

/**
 * Every app permission identifier (one without a plugin "name:" prefix) in every capability must be the generated
 * allow-<command> or deny-<command> for a command enrolled in build.rs. A custom permission or [[set]] in
 * src-tauri/permissions could bundle a vault-layer or withheld command where the grant checks cannot see it, so an
 * unrecognised identifier fails the check instead of being parsed. Plugin permissions cannot grant app commands.
 */
export function permissionIdentifierProblems(capabilityFiles, appCommands) {
  if (!Array.isArray(appCommands) || !appCommands.length) {
    return ['The native command list in src-tauri/build.rs could not be read, so capability grants cannot be checked.'];
  }
  const known = new Set(appCommands.flatMap(command => ['allow', 'deny'].map(kind => `${kind}-${command.replaceAll('_', '-')}`)));
  const problems = [];
  for (const [name, capability] of Object.entries(capabilityFiles)) {
    for (const entry of capability?.permissions ?? []) {
      const identifier = typeof entry === 'string' ? entry : entry?.identifier;
      if (typeof identifier !== 'string' || !identifier.trim()) problems.push(`${name} has a permission entry without an identifier.`);
      else if (!identifier.includes(':') && !known.has(identifier)) {
        problems.push(`${name} grants the unrecognised permission ${identifier}. App permissions must be the generated allow-<command> or deny-<command> identifiers; a custom permission or set in src-tauri/permissions is not reviewed by this check.`);
      }
    }
  }
  return problems;
}

/** Vault-layer grants: every LAYER_COMMANDS entry for the main webview, none for any other webview, window or remote origin. */
export function layerGrantProblems(capabilityFiles) {
  const problems = [];
  for (const [name, capability] of Object.entries(capabilityFiles)) {
    const granted = grantedPermissions(capability);
    const beyondMain = reachesBeyondMain(capability);
    for (const command of LAYER_COMMANDS) {
      if (grants(granted, command) && (beyondMain || name !== 'default.json')) {
        problems.push(`${name} grants the vault-layer command ${command} beyond the "main" webview's own origin; only default.json for "main" may grant it.`);
      }
    }
  }
  const main = capabilityFiles['default.json'];
  if (main) {
    const granted = grantedPermissions(main);
    for (const command of LAYER_COMMANDS) {
      if (!grants(granted, command)) problems.push(`The main webview must be granted the vault-layer command ${command} (allow-${command.replaceAll('_', '-')}).`);
    }
  }
  return problems;
}

/**
 * Problems with tauri.conf.json and the capability files. `capabilityFiles` maps file name -> parsed JSON;
 * `appCommands` is the command list enrolled in src-tauri/build.rs (see buildCommands).
 */
export function configProblems(conf, capabilityFiles, appCommands) {
  const problems = [];
  if (conf.identifier !== IDENTIFIER) problems.push(`identifier must stay ${IDENTIFIER} (local data profile).`);
  const windows = conf.app?.windows ?? [];
  if (windows.length !== 1 || windows[0].label !== 'main') problems.push('app.windows must be exactly one window labelled "main".');
  else if (windows[0].useHttpsScheme !== true) problems.push('The main window must keep useHttpsScheme: true (https://tauri.localhost origin).');
  if (conf.app?.withGlobalTauri !== false) problems.push('app.withGlobalTauri must be false: no source uses window.__TAURI__, so it only widens the IPC surface.');
  const security = conf.app?.security ?? {};
  problems.push(...cspProblems(security.csp, 'csp'));
  if (security.devCsp !== undefined && security.devCsp !== null) problems.push(...cspProblems(security.devCsp, 'devCsp'));
  if (security.dangerousDisableAssetCspModification) problems.push('app.security.dangerousDisableAssetCspModification must not be set.');
  if (Array.isArray(security.capabilities) && security.capabilities.length) problems.push('app.security.capabilities must stay empty; grants live in src-tauri/capabilities/default.json.');
  if (conf.build?.frontendDist !== '../dist') problems.push('build.frontendDist must be ../dist (the folder this check inspects).');
  if (!/\bnode scripts\/check-desktop-build\.mjs --installer\b/.test(conf.build?.beforeBuildCommand ?? '')) {
    problems.push('build.beforeBuildCommand must run "node scripts/check-desktop-build.mjs --installer" after the frontend build.');
  }

  const names = Object.keys(capabilityFiles);
  if (names.length !== 1 || names[0] !== 'default.json') problems.push(`src-tauri/capabilities must contain only default.json (found: ${names.join(', ') || 'nothing'}).`);
  const main = capabilityFiles['default.json'];
  if (main) {
    if (JSON.stringify(main.webviews) !== '["main"]') problems.push('The default capability must apply to the "main" webview only.');
    if (Array.isArray(main.windows) ? main.windows.length : main.windows !== undefined) problems.push('The default capability must not target windows (child webviews would inherit it).');
    if (main.remote !== undefined && main.remote !== null) problems.push('The default capability must not grant remote origins.');
    const granted = grantedPermissions(main);
    for (const command of DENIED_COMMANDS) {
      if (grants(granted, command)) problems.push(`The main webview must not be granted ${command}.`);
    }
  }
  problems.push(...permissionIdentifierProblems(capabilityFiles, appCommands));
  problems.push(...layerGrantProblems(capabilityFiles));
  return problems;
}

/**
 * Validates the resolved VITE_API_BASE. Returns { origin, literals, problems, warnings };
 * `literals` are the spellings Vite may have inlined (the raw value and its origin).
 * An origin other than PRODUCTION_API_BASE is an error unless `staging` is true.
 */
export function apiBaseProblems(raw, { staging = false } = {}) {
  const value = String(raw ?? '').trim();
  const problems = [];
  const warnings = [];
  if (!value) {
    problems.push(`VITE_API_BASE is empty. A packaged window is served from https://tauri.localhost, which has no API; build with VITE_API_BASE=${PRODUCTION_API_BASE}.`);
    return { origin: null, literals: [], problems, warnings };
  }
  let url;
  try { url = new URL(value); } catch { problems.push('VITE_API_BASE is not an absolute URL.'); return { origin: null, literals: [], problems, warnings }; }
  if (url.protocol !== 'https:') problems.push('VITE_API_BASE must use https:// for an installer (HTTP is mixed content from https://tauri.localhost).');
  if (url.username || url.password || url.search || url.hash) problems.push('VITE_API_BASE must not contain credentials, a query or a fragment.');
  if (url.pathname !== '/') problems.push('VITE_API_BASE must be an origin only (the API is served under /api/solares).');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) {
    problems.push('VITE_API_BASE must be a public hostname, not a local or IP address.');
  }
  const origin = problems.length ? null : url.origin;
  if (origin && origin !== PRODUCTION_API_BASE) {
    if (!staging) {
      problems.push(`VITE_API_BASE is ${origin}, not the production API ${PRODUCTION_API_BASE}. Build with VITE_API_BASE=${PRODUCTION_API_BASE}, or set ANTARA_DESKTOP_STAGING=1 for a staging installer that must not be distributed.`);
      return { origin: null, literals: [], problems, warnings };
    }
    warnings.push(`VITE_API_BASE is ${origin}, not the production API ${PRODUCTION_API_BASE}. ANTARA_DESKTOP_STAGING=1 is set: this installer is for staging only and must not be distributed.`);
  }
  return { origin, literals: origin ? [...new Set([value, origin])] : [], problems, warnings };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Problems with a built frontend folder; `apiLiterals` are the accepted API base spellings (empty skips that check). */
export function distProblems(dist, apiLiterals = []) {
  const problems = [];
  const warnings = [];
  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) return { problems: [`${dist} has no index.html. Run npm run build:app first.`], warnings, files: 0 };
  const index = readFileSync(indexPath, 'utf8');
  if (index.includes('/@vite/client')) problems.push('index.html is a development page (/@vite/client); build with npm run build:app.');
  // Tauri adds a nonce for inline <style>, which disables 'unsafe-inline' and breaks Privy's runtime styles.
  if (/<style\b/i.test(index)) problems.push('index.html contains an inline <style>; move it to a stylesheet.');
  for (const tag of index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag[1])?.[1];
    if (!src && tag[2].trim()) problems.push('index.html contains an inline <script>.');
    if (src && /^(?:https?:)?\/\//i.test(src)) problems.push(`index.html loads a remote script ${src}.`);
  }

  const files = walk(dist);
  const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.json', '.webmanifest', '.txt']);
  for (const path of files) if (/(^|[\\/])\.env|\.(pem|key)$/i.test(path)) problems.push(`Forbidden file in build: ${relative(dist, path)}`);
  const quoted = apiLiterals.flatMap(literal => [`"${literal}"`, `'${literal}'`, `\`${literal}\``]);
  let apiBaked = false;
  const localApi = new Set();
  const secretNames = new Set();
  for (const path of files) {
    if (!textExtensions.has(extname(path).toLowerCase())) continue;
    const text = readFileSync(path, 'utf8');
    const name = relative(dist, path).split('\\').join('/');
    if (LOCAL_API.test(text)) localApi.add(name);
    if (extname(path) === '.js' && quoted.some(literal => text.includes(literal))) apiBaked = true;
    for (const match of text.matchAll(/\bVITE_\w+/g)) if (isSecretEnvName(match[0])) secretNames.add(match[0]);
  }
  if (quoted.length && !apiBaked) problems.push(`The built JavaScript does not contain the API origin ${new URL(apiLiterals[0]).origin}; rebuild with the same VITE_API_BASE (dist may be stale).`);
  for (const name of localApi) problems.push(`${name} references the local development API (localhost:8787).`);
  for (const name of secretNames) problems.push(`Secret-looking public variable name in the bundle: ${name}. Never put a secret in a VITE_ variable.`);
  return { problems, warnings, files: files.length };
}

/** Public VITE_ URL settings that would inline a credential into the installer; names only, never values. */
export function envProblems(env) {
  const problems = [];
  const warnings = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('VITE_') || typeof value !== 'string' || !value.trim()) continue;
    if (isSecretEnvName(name)) problems.push(`${name} looks like a secret; Vite would inline it into the installer.`);
    else if (/^(?:https?|wss?):\/\//i.test(value.trim())) {
      const found = urlSecretProblems(value.trim().replace(/^ws/i, 'http'), { strict: false });
      if (found.length) warnings.push(`${name} contains ${found.join(', ')}; it is inlined into the installer. Use only an origin-restricted public key.`);
    }
  }
  return { problems, warnings };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main(args) {
  const installer = args.includes('--installer');
  const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist';
  if (!dirArg || dirArg.startsWith('--')) throw new Error('--dir needs a folder.');
  const errors = [];
  const warnings = [];

  const conf = readJson(join(tauriDir, 'tauri.conf.json'));
  const capabilityDir = join(tauriDir, 'capabilities');
  const capabilityFiles = Object.fromEntries(readdirSync(capabilityDir).map(name => [name, extname(name) === '.json' ? readJson(join(capabilityDir, name)) : {}]));
  const appCommands = buildCommands(readFileSync(join(tauriDir, 'build.rs'), 'utf8'));
  errors.push(...configProblems(conf, capabilityFiles, appCommands));

  let origin = null;
  let fileCount = 0;
  const dist = resolve(root, dirArg);
  if (installer) {
    const { loadEnv } = await import('vite');
    const env = loadEnv('production', root, 'VITE_');
    const api = apiBaseProblems(env.VITE_API_BASE, { staging: process.env.ANTARA_DESKTOP_STAGING === '1' });
    origin = api.origin;
    errors.push(...api.problems);
    warnings.push(...api.warnings);
    const fromEnv = envProblems(env);
    errors.push(...fromEnv.problems);
    warnings.push(...fromEnv.warnings);
    // The website's /downloads files (the installer itself and the extension zip) are
    // copied into dist by Vite for antara.tech; they never belong inside the desktop app.
    const downloads = join(dist, 'downloads');
    if (existsSync(downloads)) {
      rmSync(downloads, { recursive: true, force: true });
      warnings.push('Removed dist/downloads (website download files) from the packaged frontend.');
    }
    if (existsSync(downloads)) problems.push('dist/downloads must not be packaged into the desktop app.');
    const built = distProblems(dist, api.literals);
    errors.push(...built.problems);
    warnings.push(...built.warnings);
    fileCount = built.files;
  }

  console.log('ANTARA desktop check');
  console.log(`  identifier:   ${conf.identifier}`);
  console.log(`  capabilities: main webview, ${DENIED_COMMANDS.length} signing/reveal/import/WebAuthn/drive commands withheld, ${LAYER_COMMANDS.length} vault-layer commands granted`);
  if (installer) {
    console.log(`  frontend:     ${relative(root, dist) || dist} (${fileCount} files)`);
    console.log(`  API origin:   ${origin ?? 'invalid'}`);
  } else {
    console.log('  frontend:     not checked (pass --installer to check the packaged build)');
  }
  for (const message of warnings) console.log(`  warning: ${message}`);
  if (errors.length) {
    for (const message of errors) console.error(`  error: ${message}`);
    console.error(`FAILED with ${errors.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log('OK');
}

const invoked = Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invoked) {
  main(process.argv.slice(2)).catch(cause => {
    console.error(`ANTARA desktop check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  });
}
