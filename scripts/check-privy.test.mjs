import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPrivy, formatPrivyReport } from './check-privy.mjs';

const appId = 'configured-public-app';
const configured = () => ({ id: appId, data_classification: 'public', email_auth: true, sms_auth: false, wallet_auth: true, solana_wallet_auth: true,
  mfa_methods: ['totp'], allowed_domains: ['http://localhost:1420', 'http://127.0.0.1:1420', 'https://tauri.localhost'] });
const response = data => async () => ({ ok: true, json: async () => data });
const status = (result, variable) => result.checks.find(check => check.variable === variable)?.status;

test('public check sends only the public ID to the fixed endpoint with redirect and timeout protection', async () => {
  let calls = 0;
  const result = await checkPrivy(appId, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `https://api.privy.io/v1/apps/${encodeURIComponent(appId)}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'privy-app-id': appId, Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.body, undefined);
    return { ok: true, json: async () => configured() };
  } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.ok(result.checks.every(check => check.status === 'PASS'));
  assert.match(formatPrivyReport(result), /does not prove login, code delivery, MFA enrollment or enforcement/);
});

test('unconfigured, placeholder or invalid IDs never trigger a request', async () => {
  for (const value of [undefined, '', '  ', 'YOUR_APP_ID', 'replace-me', 'test-value', '../another-resource', '<app-id>', 'line\nbreak']) {
    const result = await checkPrivy(value, { fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.equal(status(result, 'VITE_PRIVY_APP_ID'), 'MISSING');
    assert.equal(result.exitCode, 1);
  }
});

test('required login methods and TOTP must each be enabled', async () => {
  for (const [field, variable] of [['email_auth', 'EMAIL_LOGIN'], ['wallet_auth', 'EVM_WALLET_LOGIN'], ['solana_wallet_auth', 'SOLANA_WALLET_LOGIN'], ['mfa_methods', 'TOTP_AVAILABLE']]) {
    const result = await checkPrivy(appId, { fetchImpl: response({ ...configured(), [field]: field === 'mfa_methods' ? ['sms'] : false }) });
    assert.equal(result.exitCode, 1);
    assert.equal(status(result, variable), 'MISSING');
  }
});

test('exact origins are checked for the selected mode without treating unlisted other-mode origins as blockers', async () => {
  const developmentOnly = { ...configured(), allowed_domains: ['http://localhost:1420', 'http://127.0.0.1:1420'] };
  const development = await checkPrivy(appId, { development: true, fetchImpl: response(developmentOnly) });
  assert.equal(development.exitCode, 0);
  assert.equal(status(development, 'WINDOWS_ORIGIN'), 'WARN');
  assert.equal((await checkPrivy(appId, { fetchImpl: response(developmentOnly) })).exitCode, 1);
  const packagedOnly = { ...configured(), allowed_domains: ['https://tauri.localhost'] };
  assert.equal((await checkPrivy(appId, { fetchImpl: response(packagedOnly) })).exitCode, 0);
  const developmentMissing = await checkPrivy(appId, { development: true, fetchImpl: response(packagedOnly) });
  assert.equal(status(developmentMissing, 'LOCALHOST_ORIGIN'), 'MISSING');
  assert.equal(status(developmentMissing, 'LOOPBACK_ORIGIN'), 'MISSING');
});

test('no domain restrictions warns without claiming connection is blocked', async () => {
  const result = await checkPrivy(appId, { fetchImpl: response({ ...configured(), allowed_domains: [] }) });
  assert.equal(result.exitCode, 0);
  assert.equal(status(result, 'ORIGIN_RESTRICTIONS'), 'WARN');
  assert.equal(status(result, 'WINDOWS_ORIGIN'), 'WARN');
  assert.match(formatPrivyReport(result), /This does not block a connection/);
});

test('malformed, wrong-app or incomplete public response never produces successful settings', async () => {
  for (const data of [null, [], {}, { ...configured(), id: 'other-app' }, { ...configured(), email_auth: 'true' },
    { ...configured(), allowed_domains: 'https://tauri.localhost' }, { ...configured(), allowed_domains: [123] },
    { ...configured(), mfa_methods: null }, { ...configured(), mfa_methods: [{}] }, { ...configured(), data_classification: 'private' }]) {
    const result = await checkPrivy(appId, { fetchImpl: response(data) });
    assert.equal(result.exitCode, 1);
    assert.equal(status(result, 'PUBLIC_SETTINGS'), 'MISSING');
    assert.ok(!result.checks.some(check => check.status === 'PASS'));
  }
});

test('responses, exceptions and credentials are never echoed into the diagnostic report', async () => {
  const secret = 'sentinel-secret-never-print';
  const fetches = [
    async () => { throw new Error(secret); },
    async () => ({ ok: false, statusText: secret, json: async () => { throw new Error('must not parse an error body'); } }),
    async () => ({ ok: true, json: async () => { throw new Error(secret); } }),
    response({ ...configured(), name: secret, app_secret: secret, allowed_domains: [`https://${secret}.invalid`] }),
    response({ ...configured(), name: secret, app_secret: secret }),
  ];
  for (const fetchImpl of fetches) {
    const result = await checkPrivy(appId, { fetchImpl });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!formatPrivyReport(result).includes(secret));
    assert.ok(!formatPrivyReport(result).includes(appId));
  }
});

test('timeout aborts the request and returns a redacted failure', async () => {
  const result = await checkPrivy(appId, { timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('mock timeout was not aborted')), 200);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('sensitive-timeout-details')); }, { once: true });
  }) });
  assert.equal(result.exitCode, 1);
  assert.equal(status(result, 'PUBLIC_SETTINGS'), 'MISSING');
  assert.ok(!formatPrivyReport(result).includes('sensitive-timeout-details'));
});
