#!/usr/bin/env node
// Validates a built ANTARA Chrome extension (dist-extension/) before it is loaded
// or submitted: manifest shape, minimal permissions, CSP, no remotely hosted code
// and no leaked secrets. Exits non-zero on any problem. Policy values come from
// extension/policy.mjs, the same module the build uses.
//
//   node scripts/extension-check.mjs [--dir dist-extension] [--production] [--store]
//
// --production rejects development builds (localhost API access).
// --store      checks a Chrome Web Store upload folder (implies --production): the
//              manifest must not carry "key" or "update_url" (scripts/extension-package.mjs).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORS_ORIGINS, EXTENSION_CSP, EXTENSION_PERMISSIONS, GEOLOCATION_CALL_SITES, MINIMUM_CHROME_VERSION, PASSKEY_RP_ID, PRODUCTION_API_BASE, hostPermissionsFor, isSecretEnvName,
} from '../extension/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist-extension';
const dist = resolve(root, dirArg);
const store = args.includes('--store');
const requireProduction = store || args.includes('--production');

const errors = [];
const warnings = [];
const error = message => errors.push(message);
const warn = message => warnings.push(message);

const ALLOWED_PERMISSIONS = new Set(EXTENSION_PERMISSIONS);
const MINIMUM_CHROME_MAJOR = Number(MINIMUM_CHROME_VERSION);

// Strings that mean a remote script would be fetched and executed.
const REMOTE_CODE_MARKERS = [
  'challenges.cloudflare.com',
  'hcaptcha.com',
  'telegram.org/js',
  'telegram-login.js',
  'js.stripe.com',
  'crypto-js.stripe.com',
];
const REMOTE_CODE_PATTERNS = [
  [/["'`]https?:\/\/[^"'`\s]+\.(?:m|c)?js(?:\?[^"'`\s]*)?["'`]/g, 'literal remote .js URL'],
  [/\bimport\(\s*["'`]https?:/g, 'dynamic import of a remote URL'],
  [/\bimportScripts\(\s*["'`]https?:/g, 'importScripts of a remote URL'],
  [/\beval\(\s*(?:await\s+)?\(?\s*(?:await\s+)?fetch\b/g, 'eval of fetched code'],
  [/\bnew Function\([^)]{0,200}\bfetch\(/g, 'Function constructor over fetched code'],
  [/\.src\s*=\s*["'`]https?:\/\/[^"'`]+["'`][^;]{0,80}createElement|createElement\(["']script["']\)[^;]{0,200}\.src\s*=\s*["'`]https?:/g, 'remote <script> injection'],
];
const KEY_MATERIAL = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'PEM private key'],
  [/\bsk_live_[0-9A-Za-z]{16,}/g, 'Stripe live secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/g, 'Slack token'],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/g, 'GitHub token'],
];
// Credentials carried inside URLs (an RPC override such as ?api-key=..., /v2/<key>).
// Template placeholders (${...}) in dependency code do not match.
const URL_SECRETS = [
  [/https?:\/\/[^\s"'`<>]{1,300}?[?&](?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token)=(?!\$\{)[^&\s"'`<>]{6,}/gi, 'credential query parameter in a URL'],
  [/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%-]*)*?\/v[23]\/[A-Za-z0-9_-]{20,}/g, 'key-like /v2/ or /v3/ URL path'],
  [/https?:\/\/[^\s"'`<>/@]+:[^\s"'`<>/@]+@[A-Za-z0-9.-]+/g, 'URL with embedded credentials'],
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function rel(path) {
  return relative(dist, path).split('\\').join('/');
}

function pngSize(path) {
  const data = readFileSync(path);
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function extensionId(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  return createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

function chromeVersion(packageVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(packageVersion.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error(`No manifest.json in ${rel(dist) || dist}. Run npm run build:extension:dev or npm run build:extension first.`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
} catch (cause) {
  console.error(`manifest.json is not valid JSON: ${cause.message}`);
  process.exit(1);
}

// ---- Manifest -------------------------------------------------------------
const development = typeof manifest.name === 'string' && manifest.name.endsWith('(dev)');
if (manifest.manifest_version !== 3) error('manifest_version must be 3.');
if (manifest.name !== 'ANTARA' && manifest.name !== 'ANTARA (dev)') error(`Unexpected name "${manifest.name}".`);
if (requireProduction && development) error('This is a development build (name "ANTARA (dev)"); build with npm run build:extension.');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== chromeVersion(pkg.version)) error(`version "${manifest.version}" does not match package.json "${pkg.version}".`);
// Chrome accepts a string of 1-4 dot-separated integers (a number fails to load);
// only the major version matters here.
const minimumChrome = typeof manifest.minimum_chrome_version === 'string' ? /^(\d+)(?:\.\d+){0,3}$/.exec(manifest.minimum_chrome_version) : null;
if (!minimumChrome || !(Number(minimumChrome[1]) >= MINIMUM_CHROME_MAJOR)) {
  error(`minimum_chrome_version must be at least ${MINIMUM_CHROME_VERSION} (vault passkeys claim the antara.tech RP ID from extension pages).`);
}

let computedId = null;
if (store) {
  // The store assigns the ID; an uploaded manifest must not carry "key" or "update_url".
  if (manifest.key !== undefined) error('Store upload: manifest "key" must be removed (use npm run package:extension).');
  if (manifest.update_url !== undefined) error('Store upload: manifest "update_url" must be removed.');
} else if (typeof manifest.key !== 'string' || !manifest.key) {
  error('manifest "key" is missing; the extension ID would not be stable.');
} else {
  computedId = extensionId(manifest.key);
  const committedPath = join(root, 'extension', 'extension-key.json');
  if (existsSync(committedPath)) {
    const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
    if (committed.key !== manifest.key || committed.id !== computedId) error('manifest key / ID do not match extension/extension-key.json.');
  }
}

const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
if (!Array.isArray(manifest.permissions)) error('permissions must be an array.');
// Exactly the committed set: nothing extra, nothing missing (extension/policy.mjs).
for (const permission of permissions) if (!ALLOWED_PERMISSIONS.has(permission)) error(`Permission "${permission}" is not allowed (allowed: ${[...ALLOWED_PERMISSIONS].join(', ')}).`);
for (const permission of ALLOWED_PERMISSIONS) if (!permissions.includes(permission)) error(`Permission "${permission}" is required (extension/policy.mjs EXTENSION_PERMISSIONS).`);
if (new Set(permissions).size !== permissions.length) error('permissions contains duplicates.');
// No optional permissions at all: "geolocation" cannot be optional, and anything
// requested at runtime would bypass the committed allowlist.
for (const field of ['optional_permissions', 'optional_host_permissions']) {
  if (manifest[field] !== undefined) error(`"${field}" must not be present.`);
}
for (const field of ['content_scripts', 'externally_connectable', 'update_url', 'oauth2', 'chrome_url_overrides', 'declarative_net_request']) {
  if (manifest[field] !== undefined && !(Array.isArray(manifest[field]) && manifest[field].length === 0)) error(`"${field}" must not be present in M1.`);
}
if (Array.isArray(manifest.web_accessible_resources) && manifest.web_accessible_resources.length) error('web_accessible_resources must be empty until dApp injection (M2) is approved.');

const hosts = manifest.host_permissions ?? [];
// The committed allowlist is the only source of host permissions; build-time env
// (API base, RPC overrides) must never add one. Development builds may also reach
// the local API server; production builds only ANTARA's production API.
const expectedHosts = [...hostPermissionsFor(development)];
if (JSON.stringify(hosts) !== JSON.stringify(expectedHosts)) {
  error(`host_permissions ${JSON.stringify(hosts)} differ from the committed ${development ? 'development' : 'production'} allowlist ${JSON.stringify(expectedHosts)} (extension/policy.mjs).`);
}
if (!development && hosts.some(host => /^http:|\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(host))) error('A production build must not have a local or plain-http host permission.');
for (const host of hosts) if (host === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(host)) error(`host permission "${host}" is too broad.`);
// The vault passkey RP ID is usable from extension pages only through this host permission.
if (!hosts.includes(`https://${PASSKEY_RP_ID}/*`)) error(`host_permissions must include https://${PASSKEY_RP_ID}/* so vault passkeys (rpId ${PASSKEY_RP_ID}) work in the extension.`);

const csp = manifest.content_security_policy?.extension_pages;
if (csp !== EXTENSION_CSP) error(`content_security_policy.extension_pages must be exactly: ${EXTENSION_CSP}`);
if (manifest.content_security_policy?.sandbox) error('A sandbox CSP is not expected in M1.');

const requireFile = (path, label) => {
  if (typeof path !== 'string' || !path) { error(`${label} is not set.`); return; }
  if (!existsSync(join(dist, path))) error(`${label} "${path}" does not exist in the build.`);
};
requireFile(manifest.side_panel?.default_path, 'side_panel.default_path');
// The toolbar icon must open the side panel (background sets openPanelOnActionClick).
// An action popup closes on focus loss, which breaks email OTP and MFA entry.
if (manifest.action?.default_popup !== undefined) error('action.default_popup must not be set: the toolbar icon opens the side panel.');
if (typeof manifest.action !== 'object' || manifest.action === null) error('action is required so the toolbar icon can open the side panel.');
requireFile(manifest.background?.service_worker, 'background.service_worker');
if (manifest.background?.type !== 'module') error('background.type must be "module".');
if (manifest.side_panel?.default_path !== 'sidepanel.html') error('side_panel.default_path must be sidepanel.html.');
requireFile('wallet.html', 'Full-tab wallet page');
for (const [size, path] of Object.entries({ ...(manifest.icons ?? {}), ...(manifest.action?.default_icon ?? {}) })) {
  requireFile(path, `icon ${size}`);
  if (existsSync(join(dist, path))) {
    const dimensions = pngSize(join(dist, path));
    if (!dimensions || dimensions.width !== Number(size) || dimensions.height !== Number(size)) error(`icon ${path} is not a ${size}x${size} PNG.`);
  }
}
if (!manifest.icons?.['128']) error('A 128px icon is required for the Chrome Web Store.');

// ---- Files: remote code, inline scripts, secrets --------------------------
const files = walk(dist);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.txt', '.md', '.svg', '.webmanifest']);
const forbiddenFiles = files.filter(path => /\.(pem|key|crx|env)$|(^|[\\/])\.env/i.test(path));
for (const path of forbiddenFiles) error(`Forbidden file in build: ${rel(path)}`);
for (const path of files.filter(path => /\.txt$|provenance[^\\/]*\.json$/i.test(path))) error(`Non-runtime file in package: ${rel(path)}`);
if (files.some(path => extname(path) === '.map')) warn('Source maps are present in the build.');

const secretNames = new Set();
let functionConstructors = 0;
let inlineScriptInjection = 0;
let webAssembly = 0;
// The geolocation permission gives every script in extension pages the position with no prompt, so the
// position calls are counted: only ANTARA's vault Geolocation collector may make one.
const positionCalls = [];
const watchCalls = [];
const localApi = new Set();
for (const path of files) {
  if (!textExtensions.has(extname(path).toLowerCase())) continue;
  const text = readFileSync(path, 'utf8');
  const name = rel(path);
  for (const marker of REMOTE_CODE_MARKERS) if (text.includes(marker)) error(`${name}: remote-code marker "${marker}".`);
  for (const [pattern, label] of REMOTE_CODE_PATTERNS) {
    for (const match of text.matchAll(pattern)) error(`${name}: ${label}: ${match[0].slice(0, 120)}`);
  }
  for (const [pattern, label] of KEY_MATERIAL) if (pattern.test(text)) error(`${name}: looks like it contains a ${label}.`);
  for (const [pattern, label] of URL_SECRETS) {
    // Report only the host so the check output never repeats the credential.
    for (const match of text.matchAll(pattern)) error(`${name}: ${label}: ${match[0].replace(/^(https?:\/\/)(?:[^@/?#\s]*@)?([^/?#:\s]+).*$/s, '$1$2/[redacted]')}`);
  }
  for (const match of text.matchAll(/\bVITE_\w+/g)) if (isSecretEnvName(match[0])) secretNames.add(match[0]);
  if (requireProduction && /\b(?:localhost|127\.0\.0\.1):8787\b/.test(text)) localApi.add(name);
  if (extname(path) === '.html') {
    for (const tag of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc=["']([^"']+)["']/i.exec(tag[1])?.[1];
      if (!src && tag[2].trim()) error(`${name}: inline <script> is blocked by the extension CSP.`);
      if (src && /^(https?:)?\/\//i.test(src)) error(`${name}: remote <script src="${src}">.`);
    }
    if (/<[^>]+\son[a-z]+\s*=\s*["']/i.test(text)) error(`${name}: inline event handler attributes are blocked by the extension CSP.`);
    if (/<link\b[^>]*href=["'](https?:)?\/\//i.test(text)) error(`${name}: remote <link> resource.`);
  }
  if (extname(path) === '.js') {
    functionConstructors += (text.match(/\bnew Function\(|[^.\w]Function\(\s*["'`]return this/g) ?? []).length;
    webAssembly += (text.match(/\bWebAssembly\.(?:instantiate|instantiateStreaming|compile|compileStreaming)\(|new WebAssembly\.Module\(/g) ?? []).length;
    inlineScriptInjection += (text.match(/createElement\(["']script["']\)[^;]{0,40};?[^;]{0,40}\.textContent\s*=/g) ?? []).length;
    for (const _ of text.matchAll(/\bgetCurrentPosition\s*(?:\?\.\s*)?\(|\[\s*["'`]getCurrentPosition["'`]\s*\]/g)) positionCalls.push(name);
    for (const _ of text.matchAll(/\bwatchPosition\b/g)) watchCalls.push(name);
  }
}
for (const nameFound of secretNames) error(`Secret-looking public variable name in bundle: ${nameFound}`);
for (const name of localApi) error(`${name}: production build references the local development API (localhost:8787).`);
if (webAssembly && !/'wasm-unsafe-eval'/.test(csp ?? '')) error(`${webAssembly} WebAssembly compile site(s) in the bundle, but the CSP has no 'wasm-unsafe-eval'.`);
if (positionCalls.length > GEOLOCATION_CALL_SITES) {
  error(`${positionCalls.length} getCurrentPosition call sites (${[...new Set(positionCalls)].join(', ')}); only ${GEOLOCATION_CALL_SITES} (the vault Geolocation collector) may read the position the geolocation permission grants without a prompt.`);
}
if (!positionCalls.length) warn('No getCurrentPosition call site: the geolocation permission is unused (is the vault Geolocation collector missing from the build?).');
if (watchCalls.length) error(`watchPosition in ${[...new Set(watchCalls)].join(', ')}: no code may track the position the geolocation permission grants.`);
if (functionConstructors) warn(`${functionConstructors} Function-constructor call site(s) in dependencies. The extension CSP blocks them at runtime; verify they are guarded fallbacks.`);
if (inlineScriptInjection) warn(`${inlineScriptInjection} inline <script> injection site(s) in dependencies (blocked by CSP; e.g. wallet SDK telemetry).`);

const service = manifest.background?.service_worker && existsSync(join(dist, manifest.background.service_worker))
  ? readFileSync(join(dist, manifest.background.service_worker), 'utf8') : '';
if (/\b(document|window|localStorage)\b/.test(service)) error('background service worker references DOM/window/localStorage APIs.');
if (/getAccessToken|privy|privateKey|mnemonic/i.test(service)) error('background service worker must not handle auth tokens or keys.');

// ---- Report ---------------------------------------------------------------
const bytes = files.reduce((sum, path) => sum + statSync(path).size, 0);
console.log(`ANTARA extension check: ${rel(dist) || dirArg}`);
console.log(`  build:        ${development ? 'development (localhost API allowed)' : 'production'}${store ? ' (store upload)' : ''}`);
console.log(`  version:      ${manifest.version}`);
console.log(`  extension id: ${computedId ?? (store ? 'assigned by the Chrome Web Store' : 'unknown')}`);
console.log(`  permissions:  ${permissions.join(', ')} (minimum Chrome ${manifest.minimum_chrome_version})`);
console.log(`  position:     ${positionCalls.length} getCurrentPosition call site(s), at most ${GEOLOCATION_CALL_SITES}`);
console.log(`  hosts:        ${hosts.join(', ') || 'none'} (third-party origins via CORS only: ${CORS_ORIGINS.length}; production API ${PRODUCTION_API_BASE})`);
console.log(`  files:        ${files.length} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
for (const message of warnings) console.log(`  warning: ${message}`);
if (errors.length) {
  for (const message of errors) console.error(`  error: ${message}`);
  console.error(`FAILED with ${errors.length} problem(s).`);
  process.exit(1);
}
console.log('OK');
