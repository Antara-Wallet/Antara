/**
 * The Biometrics layer: a passkey with user verification required, verified
 * by ANTARA's server (@simplewebauthn/server 13.3.x). The device verifies the
 * user (fingerprint, face or device PIN); ANTARA never receives biometric data.
 * The challenge is derived from the server nonce and the exact release or
 * change digest (digest.ts), so an assertion approves one thing only.
 *
 * This is not the legacy ARK module (providers/webauthn.ts): no in-memory
 * challenges, no vault-credentials.json, no legacy WEBAUTHN_* variables.
 */
import {
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { fromBase64Url, hasOnlyKeys, isRecord, toBase64Url } from './codec.js';
import type { LayerServerConfig } from './config.js';
import { PASSKEY_TIMEOUT_MS, WEBAUTHN_ALGORITHMS, type PasskeyCredentialRecord, type Surface } from './types.js';

/** A passkey check that did not pass; `message` is ANTARA's own text. */
export class PasskeyCheckError extends Error {
  constructor(message: string) { super(message); this.name = 'PasskeyCheckError'; }
}
const TRANSPORTS: ReadonlySet<string> = new Set<AuthenticatorTransportFuture>(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const transportsOf = (value: unknown): AuthenticatorTransportFuture[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is AuthenticatorTransportFuture => typeof item === 'string' && TRANSPORTS.has(item)))].slice(0, 8) : [];

export function requestOptions(config: LayerServerConfig, credentials: readonly PasskeyCredentialRecord[], challenge: string): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge,
    rpId: config.rpId,
    allowCredentials: credentials.map(credential => ({ id: credential.id, type: 'public-key', transports: transportsOf(credential.transports) })),
    userVerification: 'required',
    timeout: PASSKEY_TIMEOUT_MS,
  };
}

export function creationOptions(input: {
  config: LayerServerConfig; webauthnUserId: string; multisig: string; challenge: string; exclude: readonly PasskeyCredentialRecord[];
}): PublicKeyCredentialCreationOptionsJSON {
  const name = `ANTARA vault ${input.multisig.slice(0, 6)}…${input.multisig.slice(-4)}`;
  return {
    rp: { id: input.config.rpId, name: 'ANTARA' },
    user: { id: input.webauthnUserId, name, displayName: name },
    challenge: input.challenge,
    pubKeyCredParams: WEBAUTHN_ALGORITHMS.map(alg => ({ type: 'public-key' as const, alg })),
    // No attachment: a phone passkey (hybrid) is allowed as well as the device's own.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: input.exclude.map(credential => ({ id: credential.id, type: 'public-key', transports: transportsOf(credential.transports) })),
    timeout: PASSKEY_TIMEOUT_MS,
  };
}

const B64 = (value: unknown, max: number) => fromBase64Url(value, { min: 1, max }) !== null;
function assertionShape(value: unknown): value is AuthenticationResponseJSON {
  if (!hasOnlyKeys(value, ['id', 'rawId', 'type', 'response'], ['clientExtensionResults', 'authenticatorAttachment'])) return false;
  const response = value.response;
  if (!hasOnlyKeys(response, ['clientDataJSON', 'authenticatorData', 'signature'], ['userHandle'])) return false;
  return value.type === 'public-key' && value.id === value.rawId && B64(value.id, 1024) && B64(response.clientDataJSON, 2048) &&
    B64(response.authenticatorData, 1024) && B64(response.signature, 1024) && (response.userHandle == null || B64(response.userHandle, 64)) &&
    (value.clientExtensionResults === undefined || isRecord(value.clientExtensionResults)) &&
    (value.authenticatorAttachment === undefined || value.authenticatorAttachment === 'platform' || value.authenticatorAttachment === 'cross-platform');
}
function registrationShape(value: unknown): value is RegistrationResponseJSON {
  if (!hasOnlyKeys(value, ['id', 'rawId', 'type', 'response'], ['clientExtensionResults', 'authenticatorAttachment'])) return false;
  const response = value.response;
  if (!hasOnlyKeys(response, ['clientDataJSON', 'attestationObject'], ['transports', 'publicKey', 'publicKeyAlgorithm', 'authenticatorData'])) return false;
  return value.type === 'public-key' && value.id === value.rawId && B64(value.id, 1024) && B64(response.clientDataJSON, 2048) && B64(response.attestationObject, 8192) &&
    (response.transports === undefined || (Array.isArray(response.transports) && response.transports.length <= 8)) &&
    (value.clientExtensionResults === undefined || isRecord(value.clientExtensionResults));
}

/**
 * Refuses a ceremony run inside another site's frame. @simplewebauthn/server
 * 13.3.3 checks neither `crossOrigin` nor `topOrigin`, and no ANTARA surface
 * produces either (the desktop bridge writes `crossOrigin: false`), so a page
 * framing antara.tech with publickey-credentials-get or -create delegated is
 * refused here. clientDataJSON that does not decode is refused as well.
 */
function assertTopLevel(clientDataJSON: string, refusal: string) {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(clientDataJSON) ?? new Uint8Array())); }
  catch { throw new PasskeyCheckError(refusal); }
  if (!isRecord(data) || data.crossOrigin === true || 'topOrigin' in data) throw new PasskeyCheckError('Passkeys can only be used from ANTARA itself, not inside another site.');
}

export interface PasskeyAssertionFacts { credentialId: string; newCounter: number; surface: Surface; deviceType: 'singleDevice' | 'multiDevice'; backedUp: boolean }
/**
 * Verifies an assertion against the vault's active credentials: signature,
 * RP ID hash, origin allowlist, user-verification flag, the exact challenge
 * and counter regression. Throws PasskeyCheckError for any failure.
 */
export async function verifyAssertion(input: {
  response: unknown; credentials: readonly PasskeyCredentialRecord[]; expectedChallenge: string; config: LayerServerConfig;
}): Promise<PasskeyAssertionFacts> {
  if (!assertionShape(input.response)) throw new PasskeyCheckError('The passkey response is malformed.');
  const response = input.response;
  assertTopLevel(response.response.clientDataJSON, 'The passkey response is malformed.');
  const credential = input.credentials.find(item => item.id === response.id);
  if (!credential) throw new PasskeyCheckError('This passkey is not an active passkey for this vault.');
  if (credential.rpId !== input.config.rpId) throw new PasskeyCheckError('This passkey belongs to a different ANTARA domain.');
  const publicKey = fromBase64Url(credential.publicKey, { min: 16, max: 2048 });
  if (!publicKey) throw new PasskeyCheckError('The stored passkey is unreadable.');
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge: input.expectedChallenge, expectedOrigin: input.config.origins, expectedRPID: [credential.rpId],
      requireUserVerification: true, credential: { id: credential.id, publicKey, counter: credential.counter, transports: transportsOf(credential.transports) },
    });
  } catch { throw new PasskeyCheckError('Your passkey could not be verified for this request.'); }
  const info = result.authenticationInfo;
  if (result.verified !== true || info.userVerified !== true || info.credentialID !== credential.id) throw new PasskeyCheckError('Your passkey could not be verified for this request.');
  const surface = input.config.surfaceForOrigin(info.origin);
  if (!surface) throw new PasskeyCheckError('The passkey was used from an app ANTARA does not accept.');
  if (!Number.isInteger(info.newCounter) || info.newCounter < 0 || info.newCounter > 0xffffffff) throw new PasskeyCheckError('The passkey counter is invalid.');
  return { credentialId: credential.id, newCounter: info.newCounter, surface, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp };
}

export type VerifiedPasskey = Omit<PasskeyCredentialRecord, 'label' | 'addedAt'>;
/** Verifies a registration made with the `create` challenge (UV required, ES256 or RS256). Throws PasskeyCheckError. */
export async function verifyRegistration(input: { response: unknown; expectedChallenge: string; config: LayerServerConfig }): Promise<VerifiedPasskey> {
  if (!registrationShape(input.response)) throw new PasskeyCheckError('The passkey registration is malformed.');
  assertTopLevel(input.response.response.clientDataJSON, 'The passkey registration is malformed.');
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: input.response, expectedChallenge: input.expectedChallenge, expectedOrigin: input.config.origins, expectedRPID: input.config.rpId,
      requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
    });
  } catch { throw new PasskeyCheckError('The new passkey could not be verified.'); }
  if (!result.verified) throw new PasskeyCheckError('The new passkey could not be verified.');
  const info = result.registrationInfo;
  if (info.userVerified !== true) throw new PasskeyCheckError('The new passkey did not verify you (fingerprint, face or device PIN).');
  const surface = input.config.surfaceForOrigin(info.origin);
  if (!surface) throw new PasskeyCheckError('The passkey was created from an app ANTARA does not accept.');
  const id = info.credential.id;
  if (!fromBase64Url(id, { min: 1, max: 1024 }) || id !== input.response.id) throw new PasskeyCheckError('The new passkey has an invalid id.');
  return {
    id, publicKey: toBase64Url(info.credential.publicKey), counter: info.credential.counter, rpId: input.config.rpId,
    transports: transportsOf(input.response.response.transports), deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
    aaguid: info.aaguid, surface,
  };
}
