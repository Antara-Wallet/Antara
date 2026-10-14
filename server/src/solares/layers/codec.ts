import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
/**
 * Strict base64url (no padding). Node's decoder silently skips invalid
 * characters, so the text must round-trip exactly. Returns null otherwise.
 */
export function fromBase64Url(value: unknown, bounds: { min?: number; max?: number; exact?: number } = {}): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null;
  if (bounds.exact !== undefined && bytes.length !== bounds.exact) return null;
  if (bounds.min !== undefined && bytes.length < bounds.min) return null;
  if (bounds.max !== undefined && bytes.length > bounds.max) return null;
  return new Uint8Array(bytes);
}
export const sha256 = (...parts: Array<Uint8Array | string>): Uint8Array => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);
/** "<prefix>_" + base64url(12 random bytes), the item id format. */
export const randomId = (prefix: string): string => `${prefix}_${toBase64Url(randomBytes(12))}`;
export const randomToken = (length: number): string => toBase64Url(randomBytes(length));
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** True when `value` is a plain object whose keys are all in `allowed` and include every key in `required`. */
export function hasOnlyKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
export const isIsoTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
/** User-entered label: trimmed, 1..40 characters, no control characters. */
export function cleanLabel(value: unknown, max = 40): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(label) ? label : null;
}
/**
 * Text that looks like data ANTARA masks: a full IPv4 or IPv6 address, a BSSID or Bluetooth address, a
 * 12-hex identifier, or a coordinate pair. New labels must not look like one, so a label can never pass
 * for (or hide) a masked value. Same patterns as the client's unmasked-value check (src/solares/layers/schema.ts).
 */
const IDENTIFYING = [
  /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/, // a full IPv4 address
  /(?:[0-9a-f]{1,4}:){4,}/i, // a full-looking IPv6 address
  /(?<![0-9a-f])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}(?![0-9a-f])/i, // a BSSID or Bluetooth address
  /(?<![0-9a-z])[0-9a-f]{12}(?![0-9a-z])/i, // a 12-hex identifier
  /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/, // a coordinate pair
];
export const looksIdentifying = (text: string): boolean => IDENTIFYING.some(pattern => pattern.test(text));
