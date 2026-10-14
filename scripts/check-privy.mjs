import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSetup } from './doctor.mjs';

const loginFields = [
  ['EMAIL_LOGIN', 'email_auth'],
  ['EVM_WALLET_LOGIN', 'wallet_auth'],
  ['SOLANA_WALLET_LOGIN', 'solana_wallet_auth'],
];
const origins = [
  ['LOCALHOST_ORIGIN', 'http://localhost:1420', true],
  ['LOOPBACK_ORIGIN', 'http://127.0.0.1:1420', true],
  ['WINDOWS_ORIGIN', 'https://tauri.localhost', false],
];
const placeholder = /^(?:your[-_]|replace(?:[-_]|$)|change[-_]?me|placeholder|example(?:[-_]|$)|test(?:[-_]|$)|dummy|todo|x{4,})/i;
const report = checks => ({ checks, exitCode: checks.some(check => check.status === 'MISSING') ? 1 : 0 });
const failed = (variable, message) => report([{ variable, status: 'MISSING', message }]);

function validSettings(value, appId) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.id === appId &&
    loginFields.every(([, field]) => typeof value[field] === 'boolean') &&
    Array.isArray(value.mfa_methods) && value.mfa_methods.every(method => typeof method === 'string') &&
    Array.isArray(value.allowed_domains) && value.allowed_domains.every(origin => typeof origin === 'string') &&
    (value.data_classification === undefined || value.data_classification === 'public');
}

/** Read public app configuration only. Never accepts or sends an app secret. */
export async function checkPrivy(appId, { development = false, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (typeof appId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(appId.trim()) || placeholder.test(appId.trim())) {
    return failed('VITE_PRIVY_APP_ID', 'Set a non-placeholder public app ID before checking Privy.');
  }
  appId = appId.trim();
  let settings;
  try {
    const response = await fetchImpl(`https://api.privy.io/v1/apps/${encodeURIComponent(appId)}`, {
      method: 'GET', headers: { 'privy-app-id': appId, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return failed('PUBLIC_SETTINGS', 'Privy did not return public settings. Check the public app ID and retry.');
    settings = await response.json();
  } catch {
    return failed('PUBLIC_SETTINGS', 'Public settings could not be read. Check connectivity and retry.');
  }
  if (!validSettings(settings, appId)) return failed('PUBLIC_SETTINGS', 'The public settings response was not recognized.');

  const checks = loginFields.map(([variable, field]) => ({ variable, status: settings[field] ? 'PASS' : 'MISSING', message: settings[field] ? 'Enabled in Privy.' : 'Enable this login method in Privy.' }));
  const totp = settings.mfa_methods.includes('totp');
  checks.push({ variable: 'TOTP_AVAILABLE', status: totp ? 'PASS' : 'MISSING', message: totp ? 'Available for enrollment; user enrollment is not checked.' : 'Enable authenticator-app MFA in Privy.' });
  const unrestricted = settings.allowed_domains.length === 0;
  checks.push({ variable: 'ORIGIN_RESTRICTIONS', status: unrestricted ? 'WARN' : 'PASS', message: unrestricted ? 'No domain restrictions are configured. This does not block a connection.' : 'An origin restriction list is configured.' });
  for (const [variable, origin, isDevelopment] of origins) {
    const explicit = settings.allowed_domains.includes(origin);
    const required = isDevelopment === development;
    checks.push({ variable, status: explicit ? 'PASS' : unrestricted || !required ? 'WARN' : 'MISSING', message: explicit
      ? `${origin} is explicitly allowed.`
      : unrestricted ? `${origin} is not explicitly listed; the app has no domain restrictions.`
        : required ? `Explicitly allow ${origin} for this mode.` : `${origin} is not explicitly listed; it is not required for this mode.` });
  }
  return report(checks);
}

export function formatPrivyReport(result) {
  return ['ANTARA Privy check — public configuration, read-only.',
    ...result.checks.map(check => `${check.status} ${check.variable}: ${check.message}`),
    'No app secret was sent. No settings were changed and no wallet actions were requested.',
    'This does not prove login, code delivery, MFA enrollment or enforcement, or transaction success.'].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--development')) {
    console.error('Unsupported options. Use no options for packaged Windows, or --development.');
    process.exitCode = 2;
  } else {
    try {
      const development = process.argv.includes('--development');
      const { frontend } = await loadSetup({ development });
      const result = await checkPrivy(frontend.VITE_PRIVY_APP_ID, { development });
      console.log(formatPrivyReport(result));
      process.exitCode = result.exitCode;
    } catch {
      console.error(formatPrivyReport(failed('CONFIGURATION', 'Configuration could not be checked safely.')));
      process.exitCode = 1;
    }
  }
}
