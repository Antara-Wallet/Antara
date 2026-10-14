import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const { parse } = requireServer('dotenv');
const placeholder = /^(?:your[-_\s]|replace(?:[-_\s]|$)|change[-_\s]?me|placeholder|example(?:[-_\s]|$)|test(?:[-_\s]|$)|dummy|todo|x{4,})/i;
const present = value => typeof value === 'string' && value.trim().length > 0 && !placeholder.test(value.trim()) && !/[<>]|\$\{/.test(value);
// Server-only RPC overrides, in network display order (src/solares/networks.ts serverEnv).
// Unset, the API falls back to each network's rate-limited public RPC, so production requires them.
export const SERVER_RPC_VARIABLES = Object.freeze(['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL']);
// Arbitrum and Polygon are no longer supported; their variables are ignored by the API.
export const REMOVED_RPC_VARIABLES = Object.freeze(['ARBITRUM_RPC_URL', 'POLYGON_RPC_URL']);
// Optional public browser RPC overrides for the EVM networks (networks.ts browserEnv). Unset, the wallet uses the
// pinned public RPC; a set value must be a valid http(s) URL, because a malformed one keeps EVM sign-in disabled.
export const BROWSER_EVM_RPC_VARIABLES = Object.freeze(['VITE_ETHEREUM_RPC_URL', 'VITE_BSC_RPC_URL', 'VITE_ROBINHOOD_RPC_URL', 'VITE_BASE_RPC_URL']);
// Hosts that refuse (HTTP 403) every request carrying an Origin header, so the web app, desktop webview and
// extension cannot use them for Solana (networks.ts BROWSER_REFUSED_RPC_HOSTS). The server may still use them.
export const BROWSER_REFUSED_RPC_HOSTS = Object.freeze(['api.mainnet-beta.solana.com']);
// Production API origins: the public site, its www alias, the packaged desktop app and the Chrome extension.
export const PRODUCTION_ORIGINS = Object.freeze(['https://antara.tech', 'https://www.antara.tech', 'https://tauri.localhost', 'chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin']);
// Paired-vault guardian settings (server/src/solares/guardian.ts GUARDIAN_ENV). Reported present or missing only.
export const GUARDIAN_SERVER_VARIABLES = Object.freeze(['ANTARA_GUARDIAN_AUTH_KEY', 'ANTARA_GUARDIAN_SOLANA_WALLET_ID', 'ANTARA_GUARDIAN_SOLANA_ADDRESS', 'ANTARA_GUARDIAN_POLICY_ID', 'ANTARA_GUARDIAN_SIGNER_ID', 'ANTARA_GUARDIAN_OWNER_QUORUM_ID']);
export const PAIRED_VAULTS_SWITCH = 'ANTARA_PAIRED_VAULTS_ENABLED';

export function validateSetup(frontend, server, { development = false } = {}) {
  const checks = [];
  const add = (variable, valid, message) => checks.push({ variable, status: valid ? 'PASS' : 'MISSING', message });
  const required = (env, variable) => { const valid = present(env[variable]); add(variable, valid, valid ? 'Configured.' : 'Set a non-placeholder value.'); return valid; };
  const url = (env, variable, protocols, { origin = false } = {}) => {
    let valid = present(env[variable]);
    try {
      const parsed = new URL(env[variable]);
      valid &&= protocols.includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash &&
        !/(?:^|\.)(?:example|invalid|test)$|(?:^|\.)example\.(?:com|org|net)$/i.test(parsed.hostname) &&
        !(origin && (parsed.pathname !== '/' || parsed.search)) &&
        !(origin && !development && /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i.test(parsed.hostname));
    } catch { valid = false; }
    add(variable, valid, valid ? 'URL syntax configured; endpoint not contacted.' : 'Set an explicit URL with the required protocol and no placeholder or embedded user credentials.');
  };
  required(frontend, 'VITE_PRIVY_APP_ID');
  required(server, 'PRIVY_APP_ID');
  const matched = present(frontend.VITE_PRIVY_APP_ID) && frontend.VITE_PRIVY_APP_ID === server.PRIVY_APP_ID;
  add('PRIVY_APP_ID_MATCH', matched, matched ? 'Public and server app identifiers match.' : 'Public and server app identifiers must match exactly.');
  required(server, 'PRIVY_APP_SECRET');
  required(server, 'RELAY_API_KEY');
  if (development && frontend.VITE_API_BASE === '') add('VITE_API_BASE', true, 'Empty value selects the Vite development proxy.');
  else url(frontend, 'VITE_API_BASE', development ? ['http:', 'https:'] : ['https:'], { origin: true });
  for (const [env, name] of [[frontend, 'VITE_SOLANA_CLUSTER'], [server, 'SOLANA_CLUSTER']]) {
    const valid = env[name] === 'mainnet-beta' || (development && env[name] === 'devnet');
    add(name, valid, valid ? 'Supported cluster configured.' : 'Set the explicit cluster required by this mode.');
  }
  const clustersMatch = present(frontend.VITE_SOLANA_CLUSTER) && frontend.VITE_SOLANA_CLUSTER === server.SOLANA_CLUSTER;
  add('SOLANA_CLUSTER_MATCH', clustersMatch, clustersMatch ? 'Frontend and server clusters match.' : 'Frontend and server clusters must match.');
  if (development && (frontend.VITE_SOLANA_CLUSTER === 'devnet' || server.SOLANA_CLUSTER === 'devnet')) {
    checks.push({ variable: 'RELAY_CLUSTER', status: 'WARN', message: 'Relay trading requires mainnet; devnet only supports local wallet development.' });
  }
  url(frontend, 'VITE_SOLANA_RPC_URL', ['http:', 'https:']);
  url(frontend, 'VITE_SOLANA_WS_URL', ['ws:', 'wss:']);
  const refused = ['VITE_SOLANA_RPC_URL', 'VITE_SOLANA_WS_URL'].filter(name => {
    try { return BROWSER_REFUSED_RPC_HOSTS.includes(new URL(frontend[name]).hostname.toLowerCase()); } catch { return false; }
  });
  if (refused.length) add('SOLANA_BROWSER_RPC', false, `${refused.join(' and ')} ${refused.length > 1 ? 'use an endpoint' : 'uses an endpoint'} that refuses browser requests (HTTP 403 with an Origin header), so Solana fails in the web app, desktop app and extension. Use an endpoint that accepts browser requests, such as https://solana-rpc.publicnode.com, or an origin-restricted provider URL.`);
  for (const name of BROWSER_EVM_RPC_VARIABLES) if (String(frontend[name] ?? '').trim()) url(frontend, name, ['http:', 'https:']);
  for (const name of SERVER_RPC_VARIABLES) url(server, name, ['http:', 'https:']);
  const removed = REMOVED_RPC_VARIABLES.filter(name => String(server[name] ?? '').trim());
  if (removed.length) checks.push({ variable: 'REMOVED_RPC_URLS', status: 'WARN', message: `${removed.join(' and ')} ${removed.length > 1 ? 'are' : 'is'} set, but Arbitrum and Polygon are no longer supported. Remove ${removed.length > 1 ? 'them' : 'it'}.` });
  const origins = (server.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim());
  const originsValid = !origins.includes('*') && (development
    ? origins.includes('http://localhost:1420') && origins.includes('http://127.0.0.1:1420')
    : PRODUCTION_ORIGINS.every(origin => origins.includes(origin)));
  add('ALLOWED_ORIGINS', originsValid, originsValid ? 'Required app origins are explicitly allowed.' : development
    ? 'Explicitly allow this mode’s app origins without a wildcard.'
    : 'Explicitly allow the site, www, desktop and extension origins without a wildcard.');
  const switchValue = String(server[PAIRED_VAULTS_SWITCH] ?? '').trim();
  const pairedOn = switchValue === 'true';
  const guardianMissing = GUARDIAN_SERVER_VARIABLES.filter(name => !present(server[name]));
  if (!guardianMissing.length) add('PAIRED_VAULT_GUARDIAN', true, 'All guardian settings are present (values not checked; run provision-guardian --verify-policy).');
  else if (pairedOn) add('PAIRED_VAULT_GUARDIAN', false, `Paired vaults are switched on but ${guardianMissing.join(', ')} ${guardianMissing.length > 1 ? 'are' : 'is'} missing.`);
  else checks.push({ variable: 'PAIRED_VAULT_GUARDIAN', status: 'WARN', message: guardianMissing.length === GUARDIAN_SERVER_VARIABLES.length ? 'Guardian not provisioned; paired vaults stay unavailable.' : `Guardian partly configured; missing ${guardianMissing.join(', ')}.` });
  if (pairedOn) checks.push({ variable: PAIRED_VAULTS_SWITCH, status: 'WARN', message: 'Owner switch is on: confirm both go-live gates are recorded in docs/VERIFICATION.md.' });
  else checks.push({ variable: PAIRED_VAULTS_SWITCH, status: 'WARN', message: switchValue ? 'Set but not exactly "true", so paired vaults are off.' : 'Off: paired-vault routes answer not-provisioned.' });
  const pin = String(frontend.VITE_ANTARA_GUARDIAN_SOLANA ?? '').trim(), guardian = String(server.ANTARA_GUARDIAN_SOLANA_ADDRESS ?? '').trim();
  if (pin || pairedOn) {
    const pinMatches = Boolean(pin) && pin === guardian;
    add('GUARDIAN_PIN_MATCH', pinMatches, pinMatches ? 'The build pin matches the server guardian address.' : 'VITE_ANTARA_GUARDIAN_SOLANA must equal ANTARA_GUARDIAN_SOLANA_ADDRESS exactly.');
  }
  const noPublicSecrets = !Object.entries(frontend).some(([key, value]) => key.startsWith('VITE_') && /SECRET|PRIVATE_KEY|COSIGNER|RELAY_API_KEY/i.test(key) && String(value ?? '').trim());
  add('FRONTEND_SECRET_EXPOSURE', noPublicSecrets, noPublicSecrets ? 'No recognized server secret in public frontend variables.' : 'Remove server secrets from all public frontend variables.');
  return { checks, exitCode: checks.some(check => check.status === 'MISSING') ? 1 : 0 };
}

export async function loadSetup({ directory = root, environment = process.env, development = false } = {}) {
  const read = async file => {
    try { return parse(await readFile(file)); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Environment files could not be read.'); }
  };
  const mode = development ? 'development' : 'production';
  // Vite: mode-specific/local files override general files; the process wins.
  const frontendFiles = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  const frontend = Object.assign({}, ...await Promise.all(frontendFiles.map(name => read(join(directory, name)))), environment);
  // The API's dotenv/config loads server/.env without overriding process values.
  const server = { ...await read(join(directory, 'server', '.env')), ...environment };
  return { frontend, server };
}

export function formatReport(report) {
  return ['ANTARA setup check — static configuration only.',
    ...report.checks.map(check => `${check.status} ${check.variable}: ${check.message}`),
    'No values or secrets are printed. No wallets or network endpoints were contacted.',
    'This does not prove authentication, connectivity, RPC chain identity, or funded transaction success.'].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--development')) {
    console.error('Unsupported options. Use no options for production, or --development.');
    process.exitCode = 2;
  } else {
    try {
      const development = process.argv.includes('--development');
      const { frontend, server } = await loadSetup({ development });
      const report = validateSetup(frontend, server, { development });
      console.log(formatReport(report));
      process.exitCode = report.exitCode;
    } catch {
      console.error(formatReport({ checks: [{ variable: 'ENV_FILES', status: 'MISSING', message: 'Environment files could not be read safely.' }] }));
      process.exitCode = 1;
    }
  }
}
