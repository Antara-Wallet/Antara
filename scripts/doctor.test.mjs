import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BROWSER_EVM_RPC_VARIABLES, BROWSER_REFUSED_RPC_HOSTS, GUARDIAN_SERVER_VARIABLES, PRODUCTION_ORIGINS, REMOVED_RPC_VARIABLES, SERVER_RPC_VARIABLES, formatReport, loadSetup, validateSetup } from './doctor.mjs';

function configured() {
  return {
    frontend: { VITE_PRIVY_APP_ID: 'configured-app-id', VITE_API_BASE: 'https://api.antara.dev', VITE_SOLANA_CLUSTER: 'mainnet-beta', VITE_SOLANA_RPC_URL: 'https://rpc.provider.dev', VITE_SOLANA_WS_URL: 'wss://rpc.provider.dev' },
    server: { PRIVY_APP_ID: 'configured-app-id', PRIVY_APP_SECRET: 'super-secret-never-print', RELAY_API_KEY: 'relay-secret-never-print', SOLANA_CLUSTER: 'mainnet-beta', SOLANA_RPC_URL: 'https://rpc.provider.dev', ETHEREUM_RPC_URL: 'https://rpc.provider.dev', BSC_RPC_URL: 'https://rpc.provider.dev', ROBINHOOD_RPC_URL: 'https://rpc.provider.dev', BASE_RPC_URL: 'https://rpc.provider.dev', ALLOWED_ORIGINS: 'https://antara.tech,https://www.antara.tech,https://tauri.localhost,tauri://localhost,chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin' },
  };
}
const check = (report, variable) => report.checks.find(item => item.variable === variable)?.status;

test('matching production configuration passes without asserting connectivity', () => {
  const { frontend, server } = configured();
  const result = validateSetup(frontend, server);
  assert.equal(result.exitCode, 0);
  assert.match(formatReport(result), /does not prove authentication, connectivity/);
});

test('mismatched app identities and clusters fail even when every value is present', () => {
  const { frontend, server } = configured();
  server.PRIVY_APP_ID = 'different-app-id';
  server.SOLANA_CLUSTER = 'devnet';
  const result = validateSetup(frontend, server);
  assert.equal(result.exitCode, 1);
  assert.equal(check(result, 'PRIVY_APP_ID_MATCH'), 'MISSING');
  assert.equal(check(result, 'SOLANA_CLUSTER_MATCH'), 'MISSING');
});

test('production rejects local or insecure API origins; development supports explicit empty Vite proxy', () => {
  const { frontend, server } = configured();
  for (const value of ['', undefined, 'http://api.antara.dev', 'https://localhost:8787', 'https://user:password@api.antara.dev']) {
    assert.equal(check(validateSetup({ ...frontend, VITE_API_BASE: value }, server), 'VITE_API_BASE'), 'MISSING');
  }
  const development = validateSetup({ ...frontend, VITE_API_BASE: '', VITE_SOLANA_CLUSTER: 'devnet' }, { ...server, SOLANA_CLUSTER: 'devnet', ALLOWED_ORIGINS: 'http://localhost:1420,http://127.0.0.1:1420' }, { development: true });
  assert.equal(development.exitCode, 0);
  assert.equal(check(development, 'RELAY_CLUSTER'), 'WARN');
});

test('production requires the site, www, desktop and extension origins', () => {
  const { frontend, server } = configured();
  assert.equal(check(validateSetup(frontend, server), 'ALLOWED_ORIGINS'), 'PASS');
  for (const origin of PRODUCTION_ORIGINS) {
    const result = validateSetup(frontend, { ...server, ALLOWED_ORIGINS: PRODUCTION_ORIGINS.filter(value => value !== origin).join(',') });
    assert.equal(check(result, 'ALLOWED_ORIGINS'), 'MISSING', origin);
    assert.equal(result.exitCode, 1, origin);
  }
});

test('paired-vault guardian settings are reported present or missing without values, and the owner switch gates failure', async () => {
  const guardianSource = await readFile(new URL('../server/src/solares/guardian.ts', import.meta.url), 'utf8');
  const start = guardianSource.indexOf('export const GUARDIAN_ENV');
  const block = guardianSource.slice(start, guardianSource.indexOf('});', start));
  assert.deepEqual([...GUARDIAN_SERVER_VARIABLES].sort(), [...block.matchAll(/'(ANTARA_GUARDIAN_[A-Z_]+)'/g)].map(match => match[1]).sort());
  const { frontend, server } = configured();
  const off = validateSetup(frontend, server);
  assert.equal(off.exitCode, 0);
  assert.equal(check(off, 'PAIRED_VAULT_GUARDIAN'), 'WARN');
  assert.equal(check(off, 'ANTARA_PAIRED_VAULTS_ENABLED'), 'WARN');
  assert.equal(check(off, 'GUARDIAN_PIN_MATCH'), undefined);
  const switchedOn = validateSetup(frontend, { ...server, ANTARA_PAIRED_VAULTS_ENABLED: 'true', ANTARA_GUARDIAN_AUTH_KEY: 'sentinel-guardian-key-77' });
  assert.equal(switchedOn.exitCode, 1);
  assert.equal(check(switchedOn, 'PAIRED_VAULT_GUARDIAN'), 'MISSING');
  assert.equal(check(switchedOn, 'GUARDIAN_PIN_MATCH'), 'MISSING');
  assert.ok(!formatReport(switchedOn).includes('sentinel-guardian-key-77'));
  const guardian = Object.fromEntries(GUARDIAN_SERVER_VARIABLES.map(name => [name, `configured-${name.toLowerCase()}`]));
  const ready = validateSetup({ ...frontend, VITE_ANTARA_GUARDIAN_SOLANA: guardian.ANTARA_GUARDIAN_SOLANA_ADDRESS }, { ...server, ...guardian, ANTARA_PAIRED_VAULTS_ENABLED: 'true' });
  assert.equal(ready.exitCode, 0);
  assert.equal(check(ready, 'PAIRED_VAULT_GUARDIAN'), 'PASS');
  assert.equal(check(ready, 'GUARDIAN_PIN_MATCH'), 'PASS');
  assert.ok(!formatReport(ready).includes('configured-antara'));
  const mismatched = validateSetup({ ...frontend, VITE_ANTARA_GUARDIAN_SOLANA: 'another-guardian' }, { ...server, ...guardian });
  assert.equal(check(mismatched, 'GUARDIAN_PIN_MATCH'), 'MISSING');
  assert.equal(check(validateSetup(frontend, { ...server, ANTARA_PAIRED_VAULTS_ENABLED: 'TRUE' }), 'PAIRED_VAULT_GUARDIAN'), 'WARN');
});

test('missing, placeholder and wrong-protocol RPC configuration fails', () => {
  const { frontend, server } = configured();
  frontend.VITE_PRIVY_APP_ID = 'YOUR_APP_ID';
  frontend.VITE_SOLANA_WS_URL = 'https://rpc.provider.dev';
  server.RELAY_API_KEY = 'replace-me';
  server.ETHEREUM_RPC_URL = 'https://rpc.example.com';
  server.BASE_RPC_URL = '';
  server.ALLOWED_ORIGINS = '*';
  const result = validateSetup(frontend, server);
  for (const variable of ['VITE_PRIVY_APP_ID', 'VITE_SOLANA_WS_URL', 'RELAY_API_KEY', 'ETHEREUM_RPC_URL', 'BASE_RPC_URL', 'ALLOWED_ORIGINS']) assert.equal(check(result, variable), 'MISSING');
});

test('a browser Solana RPC on a host that refuses Origin-bearing requests fails, and the list matches the registry', async () => {
  const registry = await readFile(new URL('../src/solares/networks.ts', import.meta.url), 'utf8');
  const listed = /BROWSER_REFUSED_RPC_HOSTS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(registry)?.[1] ?? '';
  assert.deepEqual([...BROWSER_REFUSED_RPC_HOSTS], [...listed.matchAll(/'([^']+)'/g)].map(match => match[1]));
  const { frontend, server } = configured();
  assert.equal(check(validateSetup(frontend, server), 'SOLANA_BROWSER_RPC'), undefined);
  const official = validateSetup({ ...frontend, VITE_SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', VITE_SOLANA_WS_URL: 'wss://API.mainnet-beta.solana.com/' }, server);
  assert.equal(official.exitCode, 1);
  assert.equal(check(official, 'VITE_SOLANA_RPC_URL'), 'PASS');
  assert.equal(check(official, 'SOLANA_BROWSER_RPC'), 'MISSING');
  assert.match(formatReport(official), /VITE_SOLANA_RPC_URL and VITE_SOLANA_WS_URL use an endpoint that refuses browser requests/);
  const wsOnly = validateSetup({ ...frontend, VITE_SOLANA_WS_URL: 'wss://api.mainnet-beta.solana.com' }, server);
  assert.equal(check(wsOnly, 'SOLANA_BROWSER_RPC'), 'MISSING');
  const accepted = validateSetup({ ...frontend, VITE_SOLANA_RPC_URL: 'https://solana-rpc.publicnode.com', VITE_SOLANA_WS_URL: 'wss://solana-rpc.publicnode.com' }, server);
  assert.equal(accepted.exitCode, 0);
  assert.equal(check(accepted, 'SOLANA_BROWSER_RPC'), undefined);
  // The server may keep the official endpoint: its requests carry no Origin header.
  assert.equal(validateSetup(frontend, { ...server, SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }).exitCode, 0);
});

test('every supported network RPC is checked and the removed Arbitrum and Polygon variables are not required', async () => {
  const registry = await readFile(new URL('../src/solares/networks.ts', import.meta.url), 'utf8');
  // The doctor list must stay in step with the shared network registry.
  assert.deepEqual(SERVER_RPC_VARIABLES, [...registry.matchAll(/serverEnv: '([A-Z_]+)'/g)].map(match => match[1]));
  assert.deepEqual(SERVER_RPC_VARIABLES, ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL']);
  const { frontend, server } = configured();
  for (const variable of ['BSC_RPC_URL', 'ROBINHOOD_RPC_URL']) {
    const result = validateSetup(frontend, { ...server, [variable]: '' });
    assert.equal(result.exitCode, 1, variable);
    assert.equal(check(result, variable), 'MISSING', variable);
  }
  const result = validateSetup(frontend, server);
  for (const variable of REMOVED_RPC_VARIABLES) assert.equal(check(result, variable), undefined, variable);
  assert.equal(check(result, 'REMOVED_RPC_URLS'), undefined);
});

test('optional browser EVM RPC overrides are checked only when set, against the registry list', async () => {
  const registry = await readFile(new URL('../src/solares/networks.ts', import.meta.url), 'utf8');
  assert.deepEqual(BROWSER_EVM_RPC_VARIABLES, [...registry.matchAll(/browserEnv: '(VITE_[A-Z_]+)'/g)].map(match => match[1]).filter(name => name !== 'VITE_SOLANA_RPC_URL'));
  const { frontend, server } = configured();
  const unset = validateSetup(frontend, server);
  assert.equal(unset.exitCode, 0);
  for (const variable of BROWSER_EVM_RPC_VARIABLES) assert.equal(check(unset, variable), undefined, variable);
  assert.equal(check(validateSetup({ ...frontend, VITE_BSC_RPC_URL: 'https://bsc.provider.dev/v1' }, server), 'VITE_BSC_RPC_URL'), 'PASS');
  const malformed = validateSetup({ ...frontend, VITE_ROBINHOOD_RPC_URL: 'not a url sentinel-91c2', VITE_BASE_RPC_URL: 'ftp://base.provider.dev' }, server);
  assert.equal(malformed.exitCode, 1);
  assert.equal(check(malformed, 'VITE_ROBINHOOD_RPC_URL'), 'MISSING');
  assert.equal(check(malformed, 'VITE_BASE_RPC_URL'), 'MISSING');
  assert.ok(!formatReport(malformed).includes('sentinel-91c2'));
});

test('leftover Arbitrum or Polygon variables warn without failing or printing their values', () => {
  const { frontend, server } = configured();
  const result = validateSetup(frontend, { ...server, ARBITRUM_RPC_URL: 'https://arb.provider.dev/v2/leftover-key-91c2', POLYGON_RPC_URL: 'https://poly.provider.dev/v2/leftover-key-91c2' });
  assert.equal(result.exitCode, 0);
  assert.equal(check(result, 'REMOVED_RPC_URLS'), 'WARN');
  const output = formatReport(result);
  assert.match(output, /ARBITRUM_RPC_URL and POLYGON_RPC_URL are set/);
  assert.ok(!output.includes('leftover-key') && !output.includes('provider.dev'));
});

test('all output remains value-free for secrets, URLs and attacker-controlled variable names', () => {
  const { frontend, server } = configured();
  const secret = 'sentinel-sensitive-credential';
  frontend[`VITE_SECRET_${secret}`] = secret;
  frontend.VITE_API_BASE = `https://${secret}:password@api.antara.dev`;
  server.PRIVY_APP_SECRET = secret;
  server.RELAY_API_KEY = secret;
  const result = validateSetup(frontend, server);
  assert.equal(check(result, 'FRONTEND_SECRET_EXPOSURE'), 'MISSING');
  const output = formatReport(result);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('https://'));
  assert.ok(!output.includes('configured-app-id'));
});

test('dotenv reading honors frontend mode precedence and process overrides without altering files or process env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antara-doctor-'));
  try {
    await mkdir(join(directory, 'server'));
    await writeFile(join(directory, '.env'), 'VITE_PRIVY_APP_ID="base-value"\nVITE_SOLANA_CLUSTER=mainnet-beta\n');
    await writeFile(join(directory, '.env.local'), 'VITE_PRIVY_APP_ID=local-value\n');
    await writeFile(join(directory, '.env.production'), 'VITE_PRIVY_APP_ID=mode-value\n');
    await writeFile(join(directory, '.env.production.local'), 'VITE_PRIVY_APP_ID=mode-local-value\n');
    await writeFile(join(directory, 'server', '.env'), 'PRIVY_APP_ID="server-value"\n');
    const loaded = await loadSetup({ directory, environment: {} });
    assert.equal(loaded.frontend.VITE_PRIVY_APP_ID, 'mode-local-value');
    assert.equal(loaded.server.PRIVY_APP_ID, 'server-value');
    const overridden = await loadSetup({ directory, environment: { VITE_PRIVY_APP_ID: 'process-value', PRIVY_APP_ID: 'process-server-value' } });
    assert.equal(overridden.frontend.VITE_PRIVY_APP_ID, 'process-value');
    assert.equal(overridden.server.PRIVY_APP_ID, 'process-server-value');
    assert.equal((await loadSetup({ directory, environment: {}, development: true })).frontend.VITE_PRIVY_APP_ID, 'local-value');
    assert.equal((await loadSetup({ directory, environment: {} })).frontend.VITE_PRIVY_APP_ID, 'mode-local-value');
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('antara-doctor-'));
    await rm(target, { recursive: true, force: true });
  }
});
