/**
 * Single-use layer challenges, in memory only (docs/VAULT_LAYERS.md §5.2). A
 * restart invalidates every outstanding challenge, which fails closed: the
 * client starts again.
 */
import { randomBytes } from 'node:crypto';
import { toBase64Url } from './codec.js';
import { CHALLENGE_LIMITS, CHALLENGE_TTL_MS, type ChangeClass, type ChangeOp, type OptionalLayerId } from './types.js';

export interface LayerChallenge {
  /** base64url, 16 random bytes. */
  id: string;
  /** 32 random bytes. */
  nonce: Uint8Array;
  privyUserId: string;
  /** Privy session the challenge was issued to; null when the server did not receive one. */
  sessionId: string | null;
  multisig: string;
  purpose: 'release' | 'change';
  /** release */
  transactionIndex?: string;
  /** change */
  op?: ChangeOp;
  waived?: OptionalLayerId[];
  class?: ChangeClass;
  /** change: the WebAuthn user handle for a vault whose layer configuration does not exist yet. */
  webauthnUserId?: string;
  /**
   * mfa.add only: the new authenticator secret (base32), held in memory until the finish proves the app
   * shows its codes. It is sealed before it is stored and never written anywhere in the clear.
   */
  totpSecret?: string;
  digest: Uint8Array;
  configVersion: number;
  /** Optional layers whose evidence the challenge asks for. */
  required: OptionalLayerId[];
  issuedAt: number;
  expiresAt: number;
  /** Public IP observed at begin, or null. */
  ip: string | null;
}
export type ChallengeFields = Omit<LayerChallenge, 'id' | 'nonce' | 'issuedAt' | 'expiresAt'>;

export interface ChallengeStore {
  issue(fields: ChallengeFields): LayerChallenge;
  /** Removes and returns the challenge, or null if unknown or expired. Single use even when verification later fails. */
  take(id: unknown): LayerChallenge | null;
  readonly size: number;
}
export interface ChallengeStoreOptions { now?: () => number; ttlMs?: number; perUser?: number; total?: number }

export function createChallengeStore(options: ChallengeStoreOptions = {}): ChallengeStore {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? CHALLENGE_TTL_MS;
  const perUser = options.perUser ?? CHALLENGE_LIMITS.perUser;
  const total = options.total ?? CHALLENGE_LIMITS.total;
  // Insertion order is issue order, so the first entries are the oldest.
  const challenges = new Map<string, LayerChallenge>();
  const sweep = (at: number) => { for (const [id, item] of challenges) if (item.expiresAt <= at) challenges.delete(id); };
  return {
    issue(fields) {
      const at = now();
      sweep(at);
      const mine = [...challenges.values()].filter(item => item.privyUserId === fields.privyUserId);
      for (const old of mine.slice(0, Math.max(0, mine.length - perUser + 1))) challenges.delete(old.id);
      while (challenges.size >= total) challenges.delete(challenges.keys().next().value as string);
      const challenge: LayerChallenge = {
        ...fields, id: toBase64Url(randomBytes(16)), nonce: new Uint8Array(randomBytes(32)), issuedAt: at, expiresAt: at + ttl,
        required: [...fields.required], waived: fields.waived ? [...fields.waived] : undefined,
      };
      if (!challenge.waived) delete challenge.waived;
      challenges.set(challenge.id, challenge);
      return challenge;
    },
    take(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
      const challenge = challenges.get(id);
      if (!challenge) return null;
      challenges.delete(id);
      return challenge.expiresAt > now() ? challenge : null;
    },
    get size() { return challenges.size; },
  };
}
