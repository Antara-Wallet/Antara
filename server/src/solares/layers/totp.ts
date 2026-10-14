/**
 * ANTARA's own vault authenticator (the MFA layer, docs/VAULT_LAYERS.md §5.1, §7).
 *
 * Owner decision 2026-10-13: there is no MFA on the regular wallet and ANTARA no
 * longer reads Privy `mfa_methods`. The vault MFA layer is a vault-only RFC 6238
 * TOTP authenticator that the user turns on like Bluetooth, Wi-Fi or location:
 *
 * - SHA-1, 6 digits, 30-second steps, so Google Authenticator and every common
 *   authenticator app work with the otpauth:// QR code
 * - the 20-byte secret is generated here, shown once at enrollment, and stored
 *   only sealed with AES-256-GCM under ANTARA_VAULT_TOTP_KEY (32 bytes, base64),
 *   bound to the vault's multisig as additional data
 * - a code is accepted within one step either side of the server's clock, and
 *   each step is single use: the service records the last accepted step and
 *   refuses that step and every earlier one (replay)
 * - without a valid key nothing is enrolled or approved (503); a missing key
 *   never turns the layer off
 *
 * node:crypto only; no new dependency.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GuardianError } from '../guardian.js';
import { fromBase64Url, toBase64Url } from './codec.js';

export const TOTP = Object.freeze({ digits: 6, periodSeconds: 30, algorithm: 'SHA1', secretBytes: 20, window: 1, issuer: 'ANTARA' });
export const TOTP_KEY_ENV = 'ANTARA_VAULT_TOTP_KEY';
export const TOTP_CODE = /^\d{6}$/;
/** 32 base32 characters: a 20-byte secret. */
export const TOTP_SECRET = /^[A-Z2-7]{32}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY_MISSING = `${TOTP_KEY_ENV} is not set to 32 bytes in base64 on this server, so vault authenticator codes cannot be checked. Nothing was approved or changed.`;

/** A TOTP secret sealed with AES-256-GCM (base64url fields). */
export interface SealedTotpSecret { v: 1; iv: string; data: string; tag: string }

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
/** Strict: uppercase RFC 4648 base32 without padding; null for anything else. */
export function base32Decode(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !/^[A-Z2-7]+$/.test(text)) return null;
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

/** A new 20-byte secret as base32 (32 characters). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(TOTP.secretBytes));
export const totpStep = (at: number): number => Math.floor(at / 1000 / TOTP.periodSeconds);

/** RFC 4226 HOTP with SHA-1 and 6 digits. */
export function hotp(secret: Uint8Array, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid TOTP counter.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return (binary % 10 ** TOTP.digits).toString().padStart(TOTP.digits, '0');
}
/** The code an authenticator app shows at `at` (ms). */
export function totpCode(secret: Uint8Array | string, at: number): string {
  const bytes = typeof secret === 'string' ? base32Decode(secret) : secret;
  if (!bytes) throw new Error('Invalid TOTP secret.');
  return hotp(bytes, totpStep(at));
}

/**
 * The step whose code equals `code`, within `window` steps either side of `at`, or null.
 * Every candidate is compared in constant time. Single use is the caller's: it must
 * refuse a step that is not after the last accepted one.
 */
export function matchTotp(secret: Uint8Array, code: unknown, at: number, window: number = TOTP.window): number | null {
  if (typeof code !== 'string' || !TOTP_CODE.test(code) || !Number.isFinite(at)) return null;
  const now = totpStep(at);
  const given = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step), 'utf8'), given)) matched = step;
  }
  return matched;
}

/** The otpauth:// URI an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`${TOTP.issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${TOTP.issuer}&algorithm=${TOTP.algorithm}&digits=${TOTP.digits}&period=${TOTP.periodSeconds}`;
}

/**
 * The sealing key from ANTARA_VAULT_TOTP_KEY: exactly 32 bytes as base64 or base64url.
 * Throws GuardianError 503 when it is missing or malformed (fail closed). The error
 * names the variable, never its value.
 */
export function totpKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const value = env[TOTP_KEY_ENV]?.trim() ?? '';
  let key: Uint8Array | null = null;
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    key = bytes.length === 32 && bytes.toString('base64') === value ? new Uint8Array(bytes) : null;
  } else if (/^[A-Za-z0-9_-]{43}$/.test(value)) key = fromBase64Url(value, { exact: 32 });
  if (!key || key.every(byte => byte === 0)) throw new GuardianError(KEY_MISSING, 503, 'unavailable');
  return key;
}

const aad = (multisig: string) => Buffer.from(`ANTARA vault totp v1\0${multisig}`, 'utf8');

/** Seals a base32 secret for one vault. */
export function sealTotpSecret(secret: string, key: Uint8Array, multisig: string): SealedTotpSecret {
  const bytes = base32Decode(secret);
  if (!bytes || bytes.length !== TOTP.secretBytes || key.length !== 32) throw new Error('The authenticator secret could not be sealed.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(multisig));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { v: 1, iv: toBase64Url(iv), data: toBase64Url(data), tag: toBase64Url(cipher.getAuthTag()) };
}
/** Opens a sealed secret; throws for a wrong key, another vault or any change to the record. */
export function openTotpSecret(sealed: SealedTotpSecret, key: Uint8Array, multisig: string): Uint8Array {
  const iv = fromBase64Url(sealed.iv, { exact: 12 }), data = fromBase64Url(sealed.data, { exact: TOTP.secretBytes }), tag = fromBase64Url(sealed.tag, { exact: 16 });
  if (sealed.v !== 1 || !iv || !data || !tag || key.length !== 32) throw new Error('The authenticator secret could not be read.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(multisig));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}
export const validSealedSecret = (value: unknown): value is SealedTotpSecret => {
  const item = value as Record<string, unknown> | null;
  return !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).sort().join(',') === 'data,iv,tag,v' && item.v === 1 &&
    fromBase64Url(item.iv, { exact: 12 }) !== null && fromBase64Url(item.data, { exact: TOTP.secretBytes }) !== null && fromBase64Url(item.tag, { exact: 16 }) !== null;
};
