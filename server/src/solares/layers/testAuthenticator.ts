/**
 * TEST ONLY. Never imported by application code.
 *
 * A software WebAuthn authenticator (node:crypto P-256, attestation "none")
 * that produces RegistrationResponseJSON and AuthenticationResponseJSON with
 * chosen flags (user verification on or off), counter, origin and RP ID, and a
 * software trusted-device key that signs DevicePayloadV1 bytes the way the
 * client does (WebCrypto ECDSA P-256 / SHA-256, IEEE-P1363 r||s).
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { keyIdOf } from './device.js';
import type { DevicePayloadV1, Surface } from './types.js';

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest();
const FLAG = Object.freeze({ up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40 });

export interface TestPasskey {
  id: string;
  privateKey: KeyObject;
  rpId: string;
  /** Next signature counter value; 0 keeps the counter at zero (as synced passkeys do). */
  counter: number;
}
interface CeremonyOptions {
  challenge: string;
  rpId?: string;
  origin?: string;
  /** User verification flag; true unless set to false. */
  uv?: boolean;
  /** Overrides clientDataJSON.type. */
  type?: string;
  /** Backup eligible and backed up (a synced passkey). */
  synced?: boolean;
  /** clientDataJSON.crossOrigin; false unless set. */
  crossOrigin?: boolean;
  /** Adds clientDataJSON.topOrigin (a ceremony inside another site's frame). */
  topOrigin?: string;
}

export function createTestAuthenticator(defaults: { rpId: string; origin: string }) {
  const flags = (options: CeremonyOptions, extra = 0) =>
    FLAG.up | (options.uv === false ? 0 : FLAG.uv) | (options.synced ? FLAG.be | FLAG.bs : 0) | extra;
  const clientData = (type: string, options: CeremonyOptions) =>
    Buffer.from(JSON.stringify({
      type: options.type ?? type, challenge: options.challenge, origin: options.origin ?? defaults.origin, crossOrigin: options.crossOrigin ?? false,
      ...(options.topOrigin === undefined ? {} : { topOrigin: options.topOrigin }),
    }));
  const counterBytes = (counter: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(counter >>> 0); return bytes; };
  return {
    /** A new passkey and its registration response. */
    register(options: CeremonyOptions & { counter?: number }): { response: RegistrationResponseJSON; passkey: TestPasskey } {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const id = randomBytes(16);
      const rpId = options.rpId ?? defaults.rpId;
      const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
        [1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
      ]));
      const idLength = Buffer.alloc(2); idLength.writeUInt16BE(id.length);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags(options, FLAG.at)]), counterBytes(options.counter ?? 0), Buffer.alloc(16), idLength, id, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'], ['attStmt', new Map<string, string>()], ['authData', new Uint8Array(authData)],
      ]));
      return {
        response: {
          id: b64url(id), rawId: b64url(id), type: 'public-key',
          response: { clientDataJSON: b64url(clientData('webauthn.create', options)), attestationObject: b64url(attestationObject), transports: ['internal', 'hybrid'] },
          clientExtensionResults: {}, authenticatorAttachment: 'platform',
        },
        passkey: { id: b64url(id), privateKey, rpId, counter: (options.counter ?? 0) > 0 ? (options.counter ?? 0) + 1 : 0 },
      };
    },
    /** An assertion with `passkey`; advances its counter unless the counter is zero. */
    assert(passkey: TestPasskey, options: CeremonyOptions & { counter?: number }): AuthenticationResponseJSON {
      const counter = options.counter ?? passkey.counter;
      if (options.counter === undefined && passkey.counter > 0) passkey.counter += 1;
      const authData = Buffer.concat([sha256(options.rpId ?? passkey.rpId), Buffer.from([flags(options)]), counterBytes(counter)]);
      const data = clientData('webauthn.get', options);
      const signature = sign('sha256', Buffer.concat([authData, sha256(data)]), passkey.privateKey);
      return {
        id: passkey.id, rawId: passkey.id, type: 'public-key',
        response: { clientDataJSON: b64url(data), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: undefined },
        clientExtensionResults: {},
      };
    },
  };
}

export interface TestDevice {
  keyId: string;
  publicKeySpki: string;
  surface: Surface;
  /** Signs the exact UTF-8 JSON bytes of `payload` (or raw `bytes`), as the client does. */
  evidence(payload: DevicePayloadV1 | Record<string, unknown>, options?: { bytes?: Uint8Array; keyId?: string }): { keyId: string; payload: string; signature: string };
}
/** A software trusted-device key (P-256 by default; P-384 or RSA to test refusals). */
export function createTestDevice(surface: Surface, kind: 'p256' | 'p384' | 'rsa' = 'p256'): TestDevice {
  const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: kind === 'p384' ? 'secp384r1' : 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const keyId = keyIdOf(new Uint8Array(spki));
  return {
    keyId, publicKeySpki: b64url(spki), surface,
    evidence(payload, options = {}) {
      const bytes = options.bytes ?? new TextEncoder().encode(JSON.stringify(payload));
      const signature = kind === 'rsa' ? sign('sha256', bytes, pair.privateKey) : sign('sha256', bytes, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
      return { keyId: options.keyId ?? keyId, payload: b64url(bytes), signature: b64url(signature) };
    },
  };
}
