/**
 * Parity global setup.
 * - Re-derives every fixed fixture key in keys.ts (ed25519 from its seed, node:crypto) and
 *   stops the run on a mismatch, so the constants can never drift from their seeds.
 * - `PARITY_CLEAN=1` removes the previous captures of this run (before or after).
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_KEYS, PARITY_SEEDS } from './keys';
import { PARITY_OUT, PARITY_RUN } from './types';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) { out = ALPHABET[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}
/** Solana public key of `Keypair.fromSeed(new Uint8Array(32).fill(seed))`. */
export function deriveSolanaKey(seed: number) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  return base58(spki.subarray(spki.length - 32));
}

export default function setup() {
  for (const [role, seed] of Object.entries(PARITY_SEEDS) as [keyof typeof PARITY_SEEDS, number][]) {
    const derived = deriveSolanaKey(seed);
    if (PARITY_KEYS[role] !== derived) throw new Error(`tests/parity/keys.ts: ${role} should be ${derived} (seed ${seed}), found ${PARITY_KEYS[role]}.`);
  }
  if (process.env.PARITY_CLEAN === '1') fs.rmSync(path.join(PARITY_OUT, PARITY_RUN), { recursive: true, force: true });
  fs.mkdirSync(path.join(PARITY_OUT, PARITY_RUN, 'results'), { recursive: true });
}
