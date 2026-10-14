/**
 * Area D route module (docs/UI_ARGUS_PARITY.md 10.2): the paired-vault API and the Solana
 * account reads of the fixture vault, per `ctx.profile.vault`:
 *
 *   not-provisioned     /solana/config 503 not-provisioned
 *   mfa-missing         no vault, account reports mfaEnrolled: false (ignored since 2026-10-13: no wallet MFA)
 *   activate            no vault, everything ready to activate
 *   passkey-needed      vault verified and registered; layers with no passkey yet (emptyLayersFixture)
 *   active              biometrics, MFA, Limits and Safe Zones on; Wi-Fi and Bluetooth off
 *   pending-removal     layersFixture(): Safe Zones turning off, a pending passkey addition
 *   layers-unavailable  /solana/layers 500
 *   locked              /solana/layers 429 locked (Retry-After 900)
 *
 * (`no-pin` is a build without VITE_ANTARA_GUARDIAN_SOLANA; the parity build pins the fixture
 * guardian, so that state is covered by vaults/summary.test.ts instead of a capture.)
 *
 * `ctx.profile.approve` answers POST /solana/approve for the planet harness's behaviour scenes:
 * approved · pending · already-approved · layer-failed (Safe Zones) · hang (never answers).
 * Every answer passes the wallet's own parsers: `npx tsx tests/parity/routes/vault-chain.gen.ts --check`.
 * The chain bytes come from vault-chain.ts (generated with the real Squads serializers).
 */
import { emptyLayersFixture, layersFixture } from '../../../src/solares/layers/testFixtures';
import { PARITY_EVM_WALLETS } from '../keys';
import { fulfillJson, type RouteInstaller } from '../types';
import { MULTISIG_ACCOUNT_BASE64, PAIRED_POLICY_VERSION, PARITY_VAULT, SPL_TOKEN_PROGRAM_ID, SQUADS_PROGRAM_ID, USDC_TOKEN_ACCOUNT_BASE64 } from './vault-chain';

export const VAULT_PROFILES = ['not-provisioned', 'mfa-missing', 'activate', 'passkey-needed', 'active', 'pending-removal', 'layers-unavailable', 'locked'] as const;
export type VaultProfile = typeof VAULT_PROFILES[number];
export const RELEASE_INDEX = '12';
/** Fixture balances of the vault: 2.5 SOL and 125.5 USDC. Never real funds. */
export const VAULT_BALANCES = { lamports: 2_500_000_000, usdcRaw: '125500000' };
/** A fixed, well-formed base58 signature; never a real transaction. */
const SIGNATURE = '4'.repeat(88);

/**
 * The fixture vault's caps, taken from the layers fixture's Limits layer so GET /limits and GET /solana/layers never
 * disagree. Owner decision 2026-10-13: these are caps the user set (null = no cap); there is no server cap or minimum.
 */
const LIMITS = (layersFixture().layers.find(layer => layer.id === 'limits') as { limits: { perReleaseRaw: unknown; perDayRaw: unknown } }).limits;
const REGISTRATION = { multisig: PARITY_VAULT.multisig, vault: PARITY_VAULT.depositAddress, user: PARITY_VAULT.user, guardian: PARITY_VAULT.guardian, createdAt: '2026-10-01T09:00:00.000Z' };

/** GET /solana/config: no server release caps since the owner decision of 2026-10-13. */
export const configBody = () => ({ configured: true, guardian: PARITY_VAULT.guardian, cluster: 'mainnet-beta', policyVersion: PAIRED_POLICY_VERSION });
export function accountBody(profile: string) {
  // The user wallet is linked to the account, so it can receive releases (no link-age wait since 2026-10-13).
  const wallets = [{ address: PARITY_VAULT.user, embedded: true, pairProblem: null }];
  if (profile === 'mfa-missing') return { mfaEnrolled: false, wallets, vaults: [] };
  if (profile === 'activate') return { mfaEnrolled: true, wallets, vaults: [] };
  return { mfaEnrolled: true, wallets, vaults: [REGISTRATION] };
}
/** GET /limits?multisig=: the caps the user set for the fixture vault (none for USDC) and what it released today. */
export const usageBody = () => ({ multisig: PARITY_VAULT.multisig, limits: LIMITS, usedLast24h: { SOL: '250000000', USDC: '0' } });

/** The active vault: Biometrics (one passkey), Safe Zones, MFA and Limits on; Wi-Fi and Bluetooth off; nothing pending. */
function activeLayers() {
  const view = layersFixture();
  view.layers = view.layers.map(layer => {
    if (layer.id === 'wifi') return { id: 'wifi', kinds: ['server-observed'], status: 'not-enrolled', enforced: false, items: [] };
    if (layer.id === 'biometrics') return { ...layer, items: (layer.items as Record<string, unknown>[]).filter(item => item.state === 'active') };
    if (layer.id === 'geolocation') return { id: 'geolocation', kinds: ['device-reported'], status: 'enrolled', enforced: true, items: layer.items };
    return layer;
  });
  view.pending = [];
  // Without a Wi-Fi layer the server reports no trust verdict for the network.
  view.network = { observed: true, trusted: null };
  return view;
}
export function layersAnswer(profile: string): { status: number; body: unknown; headers?: Record<string, string> } {
  const withVault = (view: Record<string, unknown>) => ({ status: 200, body: { ...view, multisig: PARITY_VAULT.multisig } });
  switch (profile) {
    case 'not-provisioned': return { status: 503, body: { error: 'ANTARA’s vault guardian is not switched on for this server.', code: 'not-provisioned' } };
    case 'layers-unavailable': return { status: 500, body: { error: 'The vault service is unavailable. Nothing was changed.', code: 'unavailable' } };
    case 'locked': return { status: 429, body: { error: 'Too many checks failed.', code: 'locked' }, headers: { 'Retry-After': '900' } };
    case 'passkey-needed': return withVault(emptyLayersFixture());
    case 'pending-removal': return withVault(layersFixture());
    default: return withVault(activeLayers());
  }
}

/** POST /solana/layers/approval/begin for release #12 of the fixture vault: what the active vault requires. */
export function challengeBody() {
  return {
    challengeId: 'q3Jt0eS3h0d8a5bVt9k1JQ', expiresAt: '2026-10-13T10:05:00.000Z', purpose: 'release',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', digest: 'dbdf1c9d08f307ca8452c098c292fe47d25a374a3f91c65757e0af3d0616cadf', configVersion: 7,
    release: { multisig: PARITY_VAULT.multisig, transactionIndex: RELEASE_INDEX, asset: 'SOL', amountRaw: '250000000', recipient: PARITY_VAULT.user },
    required: [
      { id: 'biometrics', evidence: 'passkey' },
      { id: 'geolocation', evidence: 'device', reading: 'geo' },
      { id: 'mfa', evidence: 'server' },
      { id: 'limits', evidence: 'server' },
    ],
    devices: [{ keyId: 'AbCdEfGhIjKlMnOpQrStUv', surface: 'desktop' }],
    webauthn: {
      challenge: '16JADmcArB5slH0SZMIt7RYwkb0pLNrvdRziJyMzM9Q', rpId: 'antara.tech',
      allowCredentials: [{ id: 'Y3JlZGVudGlhbC1vbmUtZml4dHVyZQ', type: 'public-key', transports: ['internal', 'hybrid'] }],
      userVerification: 'required', timeout: 120000,
    },
  };
}
export const approvalBody = (status = 'approved') => status === 'already-approved' ? { status }
  : status === 'pending' ? { status, signature: SIGNATURE }
  : { status: 'approved', signature: SIGNATURE, asset: 'SOL', amountRaw: '250000000', recipient: PARITY_VAULT.user };
export const layerFailedBody = () => ({
  error: 'ANTARA did not approve this release.', code: 'layer-failed',
  layers: [
    { id: 'biometrics', ok: true, reason: null },
    { id: 'geolocation', ok: false, reason: 'The signed location reading is outside every safe zone.' },
    { id: 'mfa', ok: true, reason: null },
  ],
});

const accountInfo = (base64: string, owner: string, lamports: number) => ({
  context: { apiVersion: '2.0.0', slot: 1 },
  value: { data: [base64, 'base64'], executable: false, lamports, owner, rentEpoch: 0, space: Buffer.from(base64, 'base64').length },
});

export const install: RouteInstaller = async (context, ctx) => {
  const profile = ctx.profile.vault ?? 'active';
  const approve = ctx.profile.approve ?? 'approved';
  const registered = !['not-provisioned', 'mfa-missing', 'activate'].includes(profile);

  if (registered) {
    ctx.rpc.solana('getAccountInfo', params => {
      const address = Array.isArray(params) ? params[0] : null;
      if (address === PARITY_VAULT.multisig) return accountInfo(MULTISIG_ACCOUNT_BASE64, SQUADS_PROGRAM_ID, 3_090_000);
      if (address === PARITY_VAULT.usdcAccount) return accountInfo(USDC_TOKEN_ACCOUNT_BASE64, SPL_TOKEN_PROGRAM_ID, 2_039_280);
      return undefined;
    });
    // No spending limits on the fixture multisig.
    ctx.rpc.solana('getProgramAccounts', params => (Array.isArray(params) && params[0] === SQUADS_PROGRAM_ID ? [] : undefined));
    ctx.rpc.solana('getBalance', params => (Array.isArray(params) && params[0] === PARITY_VAULT.depositAddress ? { context: { apiVersion: '2.0.0', slot: 1 }, value: VAULT_BALANCES.lamports } : undefined));
    ctx.rpc.solana('getTokenAccountBalance', params => (Array.isArray(params) && params[0] === PARITY_VAULT.usdcAccount
      ? { context: { apiVersion: '2.0.0', slot: 1 }, value: { amount: VAULT_BALANCES.usdcRaw, decimals: 6, uiAmount: 125.5, uiAmountString: '125.5' } } : undefined));
  }

  await context.route(url => url.pathname.startsWith('/api/solares/paired-vault'), async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname.replace(/^\/api\/solares\/paired-vault/, '');
    // EVM networks: read-only discovery of an existing vault (none here).
    if (path === '' && method === 'GET') {
      const chain = url.searchParams.get('chain') ?? '';
      const owner = url.searchParams.get('owner') ?? PARITY_EVM_WALLETS[0].address;
      return fulfillJson(route, 200, { owner, chain, status: 'not-created', creationEnabled: false, transfersEnabled: false });
    }
    if (path === '/solana/config' && method === 'GET') {
      return profile === 'not-provisioned' ? fulfillJson(route, 503, layersAnswer('not-provisioned').body) : fulfillJson(route, 200, configBody());
    }
    if (path === '/solana/account' && method === 'GET') return fulfillJson(route, 200, accountBody(profile));
    if (path === '/limits' && method === 'GET') return fulfillJson(route, 200, usageBody());
    if (path === '/solana/layers' && method === 'GET') {
      const answer = layersAnswer(profile);
      return route.fulfill({ status: answer.status, contentType: 'application/json', headers: answer.headers, body: JSON.stringify(answer.body) });
    }
    if (path === '/solana/layers/approval/begin' && method === 'POST') return fulfillJson(route, 200, challengeBody());
    if (path === '/solana/approve' && method === 'POST') {
      const body = route.request().postDataJSON() as { layers?: unknown } | null;
      if (!body?.layers && approve !== 'no-evidence') {
        return fulfillJson(route, 403, { error: 'This release needs your protection layers.', code: 'layers-required', required: challengeBody().required });
      }
      if (approve === 'hang') return; // ANTARA never answers: the stations stay "ANTARA is checking…".
      if (approve === 'layer-failed') return fulfillJson(route, 403, layerFailedBody());
      return fulfillJson(route, 200, approvalBody(approve === 'no-evidence' ? 'approved' : approve));
    }
    return route.fallback();
  });
};
