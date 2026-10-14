/**
 * Binding (docs/VAULT_LAYERS.md §6). The server computes every digest; the
 * client only echoes them. A release digest covers the fresh on-chain vault
 * transaction bytes and the decoded intent, so evidence for one release can
 * never approve another.
 */
import { sha256, toBase64Url, toHex } from './codec.js';
import { normaliseOp } from './ops.js';
import type { ChangeOp, OptionalLayerId } from './types.js';

export { normaliseOp };

export interface ReleaseDigestInput {
  cluster: 'mainnet-beta' | 'devnet';
  multisig: string;
  /** Vault PDA from the registration. */
  vault: string;
  transactionIndex: string;
  /** Raw VaultTransaction account data from the fresh snapshot. */
  transactionData: Uint8Array;
  asset: 'SOL' | 'USDC';
  amountRaw: string;
  recipient: string;
  destination: string;
}
export function releaseDigestText(input: ReleaseDigestInput): string {
  return [
    'ANTARA release v1',
    `cluster=${input.cluster}`,
    `multisig=${input.multisig}`,
    `vault=${input.vault}`,
    `transactionIndex=${input.transactionIndex}`,
    `transaction=${toHex(sha256(input.transactionData))}`,
    `asset=${input.asset}`,
    `amountRaw=${input.amountRaw}`,
    `recipient=${input.recipient}`,
    `destination=${input.destination}`,
  ].join('\n');
}
export const releaseDigest = (input: ReleaseDigestInput): Uint8Array => sha256(releaseDigestText(input));

export interface ChangeDigestInput { multisig: string; configVersion: number; op: ChangeOp; waived: readonly OptionalLayerId[] }
export function changeDigestText(input: ChangeDigestInput): string {
  return [
    'ANTARA layer change v1',
    `multisig=${input.multisig}`,
    `configVersion=${input.configVersion}`,
    `op=${JSON.stringify(normaliseOp(input.op))}`,
    `waive=${[...input.waived].sort().join(',')}`,
  ].join('\n');
}
export const changeDigest = (input: ChangeDigestInput): Uint8Array => sha256(changeDigestText(input));

/** base64url(SHA256(UTF-8("ANTARA vault layers v1 " + kind) || 0x00 || nonce(32) || digest(32))). */
export function webauthnChallenge(kind: 'get' | 'create', nonce: Uint8Array, digest: Uint8Array): string {
  if (nonce.length !== 32 || digest.length !== 32) throw new Error('The nonce and digest must be 32 bytes each.');
  return toBase64Url(sha256(new TextEncoder().encode(`ANTARA vault layers v1 ${kind}`), Uint8Array.of(0), nonce, digest));
}

/**
 * The opaque `match.identifier` a begin answer carries for an enrolled Desktop
 * (windows-classic) Bluetooth device, so the stored hardware address is never
 * returned (docs/VAULT_LAYERS.md §9.2):
 *
 *   uppercase hex of the first 6 bytes of
 *   SHA256(UTF-8("ANTARA bluetooth match v1") || 0x00 || nonce(32) || UTF-8(identifier))
 *
 * where `identifier` is the 12 uppercase hex address. ANTARA Desktop computes
 * the same value for each connected device with the challenge nonce, and signs
 * the raw identifiers of the devices that match (never the full list). A
 * 48-bit address space can be searched offline, so this stops casual reading
 * of the address, not a determined attacker who holds the session.
 */
export function bluetoothMatchId(nonce: Uint8Array, identifier: string): string {
  if (nonce.length !== 32) throw new Error('The nonce must be 32 bytes.');
  return toHex(sha256(new TextEncoder().encode('ANTARA bluetooth match v1'), Uint8Array.of(0), nonce, new TextEncoder().encode(identifier)).subarray(0, 6)).toUpperCase();
}
