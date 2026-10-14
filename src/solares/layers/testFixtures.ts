/**
 * Test-only JSON for the vault layer API, copied from docs/VAULT_LAYERS.md section 9 with
 * valid Solana addresses and challenge values. Shared by the unit tests and the browser
 * fixture (tests/fixtures/layers.tsx). No imports, so Playwright can load it in Node too.
 * Never import this from application code.
 */

/** Deterministic, valid base58 addresses (fixed seeds; never funded). */
export const FIXTURE_MULTISIG = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ';
export const FIXTURE_RECIPIENT = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
export const FIXTURE_USER = 'privy:fixture-user';

/** nonce = bytes 0..31; digest = SHA-256("ANTARA client fixture digest"). */
export const FIXTURE_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const FIXTURE_DIGEST = 'dbdf1c9d08f307ca8452c098c292fe47d25a374a3f91c65757e0af3d0616cadf';
/** webauthnChallenge('get' | 'create', FIXTURE_NONCE, FIXTURE_DIGEST), computed with the server's digest.ts (section 6.2). */
export const FIXTURE_WEBAUTHN_GET = '16JADmcArB5slH0SZMIt7RYwkb0pLNrvdRziJyMzM9Q';
export const FIXTURE_WEBAUTHN_CREATE = '947aKFXkx2t-abzEq2kAqodW-Bfrwn8iZmeEAyuBe5c';
export const FIXTURE_CHALLENGE_ID = 'q3Jt0eS3h0d8a5bVt9k1JQ';
export const FIXTURE_CREDENTIAL = 'Y3JlZGVudGlhbC1vbmUtZml4dHVyZQ';
export const FIXTURE_DEVICE_KEY = 'AbCdEfGhIjKlMnOpQrStUv';
/** bluetoothMatchId(FIXTURE_NONCE, '001A7DDA7113'), computed with the server's digest.ts: how a begin answer names an enrolled Desktop device (section 9.2). */
export const FIXTURE_BLUETOOTH_MATCH = '29950C0253C8';

/** Caps this fixture's user set through the optional Limits layer (raw units; null = no cap). There is no server cap, ceiling or minimum. */
const LIMITS = {
  perReleaseRaw: { SOL: '500000000', USDC: null as string | null }, perDayRaw: { SOL: '2000000000', USDC: '200000000' as string | null },
};
/** The Limits layer while it is off (the default): every value null. */
export const NO_LIMITS = { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } };

/** GET /solana/layers, section 9.1. */
export function layersFixture(): Record<string, unknown> & { layers: Record<string, unknown>[]; devices: Record<string, unknown>[]; pending: Record<string, unknown>[] } {
  return {
    multisig: FIXTURE_MULTISIG,
    configVersion: 7,
    serverTime: '2026-10-13T10:00:00.000Z',
    network: { observed: true, trusted: false },
    layers: [
      { id: 'bluetooth', kinds: ['device-reported'], status: 'not-enrolled', enforced: false, items: [] },
      { id: 'wifi', kinds: ['server-observed'], status: 'enrolled', enforced: true, mode: 'network',
        items: [{ id: 'net_x1', type: 'network', label: 'Home', detail: 'IPv4 203.0.x.x/32', state: 'active', since: '2026-10-10T08:00:00.000Z' }] },
      { id: 'biometrics', kinds: ['cryptographic'], status: 'enrolled', enforced: true,
        items: [
          { id: FIXTURE_CREDENTIAL, type: 'passkey', label: 'Windows Hello', detail: 'Device-bound passkey · added from ANTARA Desktop', state: 'active', since: '2026-10-09T08:00:00.000Z' },
          { id: 'Y3JlZGVudGlhbC10d28', type: 'passkey', label: 'Phone', detail: 'Synced passkey · added from Web', state: 'pending-addition', effectiveAt: '2026-10-14T09:00:00.000Z', changeId: 'chg_a1' },
        ] },
      { id: 'geolocation', kinds: ['device-reported'], status: 'pending-removal', enforced: true, changeId: 'chg_b2', effectiveAt: '2026-10-14T10:00:00.000Z',
        items: [{ id: 'zone_q', type: 'zone', label: 'Home', detail: 'Radius 250 m', state: 'active', since: '2026-10-08T08:00:00.000Z' }] },
      { id: 'mfa', kinds: ['cryptographic'], status: 'enrolled', enforced: true,
        items: [{ id: 'totp_AAAAAAAAAAAAAAAA', type: 'authenticator', label: 'Phone app', detail: 'Authenticator app · 6-digit codes, each used once', state: 'active', since: '2026-10-09T08:00:00.000Z' }] },
      // A fresh copy: tests mutate fixtures, and a shared nested object would leak into later tests.
      { id: 'limits', kinds: ['cryptographic'], status: 'enrolled', enforced: true, items: [], limits: JSON.parse(JSON.stringify(LIMITS)) as typeof LIMITS },
    ],
    devices: [{ keyId: FIXTURE_DEVICE_KEY, label: 'Desktop', surface: 'desktop', state: 'active', since: '2026-10-09T08:00:00.000Z' }],
    pending: [
      { id: 'chg_a1', class: 'loosen', summary: 'Add passkey “Phone”', requestedAt: '2026-10-13T09:00:00.000Z', effectiveAt: '2026-10-14T09:00:00.000Z', waived: [] },
      { id: 'chg_b2', class: 'loosen', summary: 'Turn off Safe Zones', requestedAt: '2026-10-13T10:00:00.000Z', effectiveAt: '2026-10-14T10:00:00.000Z', waived: [] },
    ],
  };
}

/**
 * A pending recovery passkey.add that waives Biometrics (7 days), as the server's describeLayers returns it: the
 * summary quotes the label. Labels are any printable text, so one may look like an address, an identifier or coordinates.
 */
export const LABELS_THAT_LOOK_UNMASKED = ['Backup 10.0.0.1', 'Key 001A7DDA7113', 'Cabin 48.8566, 2.3522'] as const;
export function recoveryPendingFixture(label: string): ReturnType<typeof layersFixture> {
  const view = layersFixture();
  const biometrics = view.layers[2];
  biometrics.items = [
    (biometrics.items as Record<string, unknown>[])[0],
    { id: 'YXR0YWNrZXItcGFzc2tleQ', type: 'passkey', label, detail: 'Synced passkey · added from Web', state: 'pending-addition', effectiveAt: '2026-10-20T09:00:00.000Z', changeId: 'chg_r7' },
  ];
  view.pending = [
    view.pending[1],
    { id: 'chg_r7', class: 'recovery', summary: `Add passkey "${label}"`, requestedAt: '2026-10-13T09:00:00.000Z', effectiveAt: '2026-10-20T09:00:00.000Z', waived: ['biometrics'] },
  ];
  return view;
}

/** A vault with no optional layer yet: a passkey is still needed to finish activating it. */
export function emptyLayersFixture(biometricsEnforced = true): ReturnType<typeof layersFixture> {
  const view = layersFixture();
  return {
    ...view, configVersion: 1, network: { observed: true, trusted: null },
    layers: view.layers.map(layer => layer.id === 'limits' ? { id: 'limits', kinds: ['cryptographic'], status: 'not-enrolled', enforced: false, items: [], limits: JSON.parse(JSON.stringify(NO_LIMITS)) }
      : { id: layer.id, kinds: layer.id === 'wifi' ? ['server-observed'] : layer.kinds, status: 'not-enrolled', enforced: layer.id === 'biometrics' && biometricsEnforced, items: [] }),
    devices: [], pending: [],
  };
}

/** A vault right after activation: its passkey in force, every other layer off and no trusted device yet. */
export function passkeyOnlyFixture(): ReturnType<typeof layersFixture> {
  const view = emptyLayersFixture();
  view.configVersion = 2;
  view.layers = view.layers.map(layer => layer.id !== 'biometrics' ? layer : {
    id: 'biometrics', kinds: ['cryptographic'], status: 'enrolled', enforced: true,
    items: [{ id: FIXTURE_CREDENTIAL, type: 'passkey', label: 'Windows Hello', detail: 'Device-bound passkey · added from ANTARA Desktop', state: 'active', since: '2026-10-13T09:00:00.000Z' }],
  });
  return view;
}

/** POST /solana/layers/approval/begin, section 9.2. */
export function releaseChallengeFixture(release: { transactionIndex?: string; asset?: 'SOL' | 'USDC'; amountRaw?: string; recipient?: string } = {}) {
  return {
    challengeId: FIXTURE_CHALLENGE_ID,
    expiresAt: '2026-10-13T10:05:00.000Z',
    purpose: 'release',
    nonce: FIXTURE_NONCE,
    digest: FIXTURE_DIGEST,
    configVersion: 7,
    release: { multisig: FIXTURE_MULTISIG, transactionIndex: release.transactionIndex ?? '12', asset: release.asset ?? 'SOL', amountRaw: release.amountRaw ?? '250000000', recipient: release.recipient ?? FIXTURE_RECIPIENT },
    required: [
      { id: 'biometrics', evidence: 'passkey' },
      { id: 'geolocation', evidence: 'device', reading: 'geo' },
      { id: 'wifi', evidence: 'server' },
      { id: 'bluetooth', evidence: 'device', reading: 'bluetooth', match: [{ surface: 'desktop', source: 'windows-classic', identifier: FIXTURE_BLUETOOTH_MATCH, name: '' }] },
      { id: 'mfa', evidence: 'server' },
      { id: 'limits', evidence: 'server' },
    ] as Record<string, unknown>[],
    devices: [{ keyId: FIXTURE_DEVICE_KEY, surface: 'desktop' }],
    webauthn: {
      challenge: FIXTURE_WEBAUTHN_GET, rpId: 'antara.tech',
      allowCredentials: [{ id: FIXTURE_CREDENTIAL, type: 'public-key', transports: ['internal', 'hybrid'] }],
      userVerification: 'required', timeout: 120000,
    } as Record<string, unknown> | null,
  };
}

/** POST /solana/layers/enroll/begin for passkey.add, section 9.4. */
export function enrollChallengeFixture() {
  return {
    challengeId: FIXTURE_CHALLENGE_ID, expiresAt: '2026-10-13T10:05:00.000Z', purpose: 'change', nonce: FIXTURE_NONCE, digest: FIXTURE_DIGEST, configVersion: 7,
    class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z',
    required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }] as Record<string, unknown>[],
    devices: [],
    webauthn: {
      get: { challenge: FIXTURE_WEBAUTHN_GET, rpId: 'antara.tech', allowCredentials: [{ id: FIXTURE_CREDENTIAL, type: 'public-key' }], userVerification: 'required', timeout: 120000 },
      create: {
        rp: { id: 'antara.tech', name: 'ANTARA' }, user: { id: 'dXNlci1oYW5kbGUtZml4dHVyZS0zMi1ieXRlcy0hISE', name: 'ANTARA vault 7jmBsJ…SEDQ', displayName: 'ANTARA vault 7jmBsJ…SEDQ' },
        challenge: FIXTURE_WEBAUTHN_CREATE, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, attestation: 'none',
        excludeCredentials: [{ id: FIXTURE_CREDENTIAL, type: 'public-key' }], timeout: 120000,
      } as Record<string, unknown> | null,
    },
    capture: {},
  };
}
