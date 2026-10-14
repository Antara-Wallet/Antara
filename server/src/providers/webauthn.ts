import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { resolve } from "node:path";
import { readSecurityStore, writeSecurityStore } from "../solares/storage.js";
import type { Address } from "viem";
import {
  WEBAUTHN_RP_ID,
  WEBAUTHN_RP_NAME,
  webauthnOrigins,
} from "../config.js";
import type { ChainId } from "./uniswap.js";

/**
 * WebAuthn relying party — the real "Face ID" vault layer. We are the RP: we
 * issue challenges and VERIFY the signed assertion. The biometric runs on the
 * user's phone/device; we only ever see public keys + signatures, never the
 * biometric itself. Authentication challenges are bound to a specific safeTxHash
 * so an approval can't be replayed against a different transfer.
 *
 * Passkeys (base64url-encoded credential material) are persisted per vault. The
 * actual biometric capture happens on the client via the native system WebAuthn
 * API (tauri-plugin-webauthn) — `navigator.credentials` does not work in the
 * Tauri webview.
 */

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const FILE = resolve(DATA_DIR, "vault-credentials.json");

interface StoredCredential {
  id: string; // base64url credential ID
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

type CredStore = Record<string, StoredCredential[]>;

function key(chain: ChainId, safeAddress: Address): string {
  return `${chain}:${safeAddress.toLowerCase()}`;
}

function loadCreds(): CredStore {
  return readSecurityStore<CredStore>(FILE);
}

function persistCreds(store: CredStore): void {
  writeSecurityStore(FILE, store);
}

function getCreds(chain: ChainId, safeAddress: Address): StoredCredential[] {
  return loadCreds()[key(chain, safeAddress)] ?? [];
}

function addCred(chain: ChainId, safeAddress: Address, cred: StoredCredential): void {
  const store = loadCreds();
  const k = key(chain, safeAddress);
  store[k] = [...(store[k] ?? []).filter((c) => c.id !== cred.id), cred];
  persistCreds(store);
}

export function hasCredential(chain: ChainId, safeAddress: Address): boolean {
  return getCreds(chain, safeAddress).length > 0;
}

/** Wipe ALL enrolled credentials (admin reset, e.g. to re-run a fresh demo). */
export function clearAllCredentials(): number {
  const n = Object.keys(loadCreds()).length;
  persistCreds({});
  return n;
}

// Short-lived challenges (in-memory; lost on restart, which is fine).
const challenges = new Map<string, { challenge: string; expires: number }>();
const TTL_MS = 5 * 60_000;

function putChallenge(k: string, challenge: string): void {
  challenges.set(k, { challenge, expires: Date.now() + TTL_MS });
}
function takeChallenge(k: string): string | null {
  const v = challenges.get(k);
  challenges.delete(k);
  if (!v || v.expires < Date.now()) return null;
  return v.challenge;
}

// ---- Registration (enroll a passkey for a vault) ----

export async function registrationOptions(
  chain: ChainId,
  safeAddress: Address
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID: WEBAUTHN_RP_ID,
    userName: `vault ${safeAddress.slice(0, 10)}`,
    userID: isoBase64URL.toBuffer(isoBase64URL.fromUTF8String(key(chain, safeAddress))),
    attestationType: "none",
    // Intentionally empty: each vault is its own account, and the SAME phone may
    // legitimately enroll a passkey per vault (and re-enroll one). Excluding
    // existing credentials makes the authenticator throw "previously registered"
    // (InvalidStateError), which blocked setting up Face ID on a second vault.
    excludeCredentials: [],
    // authenticatorAttachment: "platform" pins the passkey to THIS device's
    // built-in biometric (Face ID / Touch ID / Windows Hello). Without it the OS
    // may create a roaming credential, and the browser then offers "use a passkey
    // from another device" (a cross-device QR) at approval instead of the local
    // Face ID sheet. residentKey "required" makes it a discoverable passkey so it
    // is reliably found on the same device.
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required",
      residentKey: "required",
    },
  });
  putChallenge(`reg:${key(chain, safeAddress)}`, options.challenge);
  return options;
}

export async function verifyRegistration(
  chain: ChainId,
  safeAddress: Address,
  response: RegistrationResponseJSON
): Promise<boolean> {
  const expectedChallenge = takeChallenge(`reg:${key(chain, safeAddress)}`);
  if (!expectedChallenge) throw new Error("registration challenge expired");
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthnOrigins(),
    expectedRPID: WEBAUTHN_RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential } = verification.registrationInfo;
  addCred(chain, safeAddress, {
    id: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
  });
  return true;
}

// ---- Authentication (approve a spend, bound to safeTxHash) ----

export async function authenticationOptions(
  chain: ChainId,
  safeAddress: Address,
  safeTxHash: string
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const creds = getCreds(chain, safeAddress);
  if (creds.length === 0) throw new Error("no passkey enrolled for this vault");
  const options = await generateAuthenticationOptions({
    rpID: WEBAUTHN_RP_ID,
    // Drop the "hybrid" (cross-device) transport hint so the browser uses the
    // passkey on THIS device (Face ID / Touch ID / Windows Hello) directly,
    // instead of popping the "scan with another device" QR. The device that
    // enrolled is the device that approves.
    allowCredentials: creds.map((c) => {
      const transports = c.transports?.filter((t) => t !== "hybrid");
      return { id: c.id, transports: transports && transports.length ? transports : undefined };
    }),
    userVerification: "required",
  });
  // Bind this challenge to the exact transaction being approved.
  putChallenge(`auth:${key(chain, safeAddress)}:${safeTxHash.toLowerCase()}`, options.challenge);
  return options;
}

/**
 * Verify a biometric approval for a specific safeTxHash. Returns true only if
 * the assertion is valid for an enrolled credential AND was produced for this
 * exact transaction's challenge.
 */
export async function verifyAuthentication(
  chain: ChainId,
  safeAddress: Address,
  safeTxHash: string,
  response: AuthenticationResponseJSON
): Promise<boolean> {
  const expectedChallenge = takeChallenge(
    `auth:${key(chain, safeAddress)}:${safeTxHash.toLowerCase()}`
  );
  if (!expectedChallenge) return false;

  const creds = getCreds(chain, safeAddress);
  const cred = creds.find((c) => c.id === response.id);
  if (!cred) return false;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthnOrigins(),
    expectedRPID: WEBAUTHN_RP_ID,
    requireUserVerification: true,
    credential: {
      id: cred.id,
      publicKey: isoBase64URL.toBuffer(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports,
    },
  });
  if (!verification.verified) return false;

  // Persist the updated signature counter (clone-detection).
  addCred(chain, safeAddress, {
    ...cred,
    counter: verification.authenticationInfo.newCounter,
  });
  return true;
}
