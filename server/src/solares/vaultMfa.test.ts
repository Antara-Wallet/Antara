/**
 * ANTARA's own vault authenticator (layers/totp.ts): RFC 6238 codes, the one-step window,
 * sealing at rest and the fail-closed key. The route behaviour (enroll, single use per step,
 * no Privy MFA anywhere) is in pairedVault.test.ts ("vault MFA").
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GuardianError } from './guardian.js';
import {
  TOTP_KEY_ENV, base32Decode, base32Encode, generateTotpSecret, hotp, matchTotp, openTotpSecret, otpauthUri, sealTotpSecret, totpCode, totpKeyFromEnv, totpStep, validSealedSecret,
} from './layers/totp.js';
import { validLayerConfig } from './layers/schema.js';
import { emptyLayerConfig, evaluateLayers, requirementList } from './layers/policy.js';

// RFC 6238 appendix B (SHA-1): the ASCII secret "12345678901234567890".
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const KEY = new Uint8Array(32).fill(7);
const MULTISIG = 'GzLbVNfUpdjSFSV8m4zQX7bGmc3Q4yDrN2RtgwV1hLbq';

describe('vault authenticator codes (RFC 6238, SHA-1, 6 digits, 30 seconds)', () => {
  it('matches the RFC test vectors and RFC 4226 HOTP values', () => {
    // The RFC lists 8 digits; an authenticator app shows the last 6.
    for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const) {
      assert.equal(totpCode(RFC_SECRET, seconds * 1000), code, String(seconds));
    }
    assert.deepEqual([0, 1, 2].map(counter => hotp(RFC_SECRET, counter)), ['755224', '287082', '359152']);
    assert.equal(totpStep(59_999), 1); assert.equal(totpStep(60_000), 2);
  });
  it('round-trips base32 strictly and generates 20-byte secrets', () => {
    const secret = generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(secret)!.length, 20);
    assert.equal(base32Encode(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), RFC_SECRET);
    for (const bad of ['gezdgnbv', 'GEZ=', 'GEZ1', '', 7]) assert.equal(base32Decode(bad), null, String(bad));
    assert.notEqual(generateTotpSecret(), secret);
    assert.equal(otpauthUri(secret, 'Vault GzLbVN'), `otpauth://totp/ANTARA%3AVault%20GzLbVN?secret=${secret}&issuer=ANTARA&algorithm=SHA1&digits=6&period=30`);
  });
  it('accepts a code one step either side and nothing further, and returns the step it matched', () => {
    const at = 1_760_000_000_000;
    const step = totpStep(at);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, at), at), step);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, at - 30_000), at), step - 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, at + 30_000), at), step + 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, at - 60_000), at), null);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, at + 60_000), at), null);
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', 123456, null, undefined]) assert.equal(matchTotp(RFC_SECRET, bad, at), null, String(bad));
  });
});

describe('vault authenticator secret at rest (AES-256-GCM)', () => {
  it('seals the secret so the stored record never contains it, and opens it only with the same key and vault', () => {
    const secret = generateTotpSecret();
    const raw = Buffer.from(base32Decode(secret)!);
    const sealed = sealTotpSecret(secret, KEY, MULTISIG);
    assert.ok(validSealedSecret(sealed));
    const text = JSON.stringify(sealed);
    for (const form of [secret, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')]) assert.equal(text.includes(form), false);
    assert.deepEqual(Buffer.from(openTotpSecret(sealed, KEY, MULTISIG)), raw);
    // A fresh IV every time.
    assert.notEqual(sealTotpSecret(secret, KEY, MULTISIG).iv, sealed.iv);
    assert.throws(() => openTotpSecret(sealed, new Uint8Array(32).fill(8), MULTISIG), 'wrong key');
    assert.throws(() => openTotpSecret(sealed, KEY, 'So11111111111111111111111111111111111111112'), 'another vault');
    const flipped = { ...sealed, data: Buffer.from(Buffer.from(sealed.data, 'base64url').map((byte, index) => index === 0 ? byte ^ 1 : byte)).toString('base64url') };
    assert.throws(() => openTotpSecret(flipped, KEY, MULTISIG), 'tampered');
    assert.equal(validSealedSecret({ ...sealed, secret }), false);
  });
  it('stores only a valid sealed record in the layer configuration', () => {
    const base = { ...emptyLayerConfig('A'.repeat(43), '2026-10-13T09:00:00.000Z'), version: 1 };
    const authenticator = { id: `totp_${'A'.repeat(16)}`, label: 'Phone app', secret: sealTotpSecret(generateTotpSecret(), KEY, MULTISIG), lastStep: 5, addedAt: '2026-10-13T09:00:00.000Z' };
    assert.equal(validLayerConfig({ ...base, mfa: authenticator }), true);
    // Documents written before the vault authenticator existed have no `mfa` (read as off).
    const { mfa: _absent, ...legacy } = base;
    assert.equal(validLayerConfig(legacy), true);
    assert.equal(validLayerConfig({ ...base, mfa: { ...authenticator, secret: generateTotpSecret() } }), false, 'a plain secret is never valid');
    assert.equal(validLayerConfig({ ...base, mfa: { ...authenticator, lastStep: -1 } }), false);
    assert.equal(validLayerConfig({ ...base, mfa: { ...authenticator, code: '123456' } }), false);
  });
  it('fails closed without a valid 32-byte key, naming the variable and never the value', () => {
    for (const value of [undefined, '', 'short', Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), Buffer.alloc(32).toString('base64')]) {
      assert.throws(() => totpKeyFromEnv({ [TOTP_KEY_ENV]: value }), (error: unknown) =>
        error instanceof GuardianError && error.status === 503 && error.code === 'unavailable' && error.message.includes(TOTP_KEY_ENV) && (!value || !error.message.includes(value)), String(value));
    }
    assert.deepEqual(totpKeyFromEnv({ [TOTP_KEY_ENV]: Buffer.from(KEY).toString('base64') }), KEY);
    assert.deepEqual(totpKeyFromEnv({ [TOTP_KEY_ENV]: Buffer.from(KEY).toString('base64url') }), KEY);
  });
});

describe('MFA layer evaluation', () => {
  const config = {
    ...emptyLayerConfig('A'.repeat(43), '2026-10-13T09:00:00.000Z'), version: 1,
    mfa: { id: `totp_${'A'.repeat(16)}`, label: 'Phone app', secret: sealTotpSecret(generateTotpSecret(), KEY, MULTISIG), lastStep: 0, addedAt: '2026-10-13T09:00:00.000Z' },
  };
  const challenge = { id: 'A'.repeat(22), nonce: new Uint8Array(32), digest: new Uint8Array(32), purpose: 'release' as const, issuedAt: 0 };
  const evaluate = (totp: Parameters<typeof evaluateLayers>[0]['totp']) =>
    evaluateLayers({ config, required: ['mfa'], challenge, passkey: null, device: null, totp, network: { status: 'not-public' }, now: 0 });
  it('asks for a code only when the vault authenticator is on, and passes only a checked code', () => {
    // Limits is optional and off here, so it is neither required nor enforced (owner decision 2026-10-13).
    assert.deepEqual(requirementList(config, ['mfa'], true, null), [{ id: 'mfa', evidence: 'totp' }]);
    assert.deepEqual(requirementList(config, [], true, null), []);
    assert.deepEqual(evaluate({ ok: true, step: 1 }), { ok: true, layers: [{ id: 'mfa', ok: true }], enforced: ['mfa'] });
    assert.equal(evaluate(null).ok, false);
    assert.equal(evaluate(undefined).ok, false);
    assert.deepEqual(evaluate({ ok: false, reason: 'wrong' }).layers, [{ id: 'mfa', ok: false, reason: 'wrong' }]);
    const off = evaluateLayers({ config: { ...config, mfa: null }, required: ['mfa'], challenge, passkey: null, device: null, totp: { ok: true, step: 1 }, network: { status: 'not-public' }, now: 0 });
    assert.equal(off.ok, false, 'a required MFA layer without an authenticator never passes');
  });
});
