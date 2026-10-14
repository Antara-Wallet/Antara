/**
 * Failure lockout (docs/VAULT_LAYERS.md §5.2), in memory: 5 failed evidence
 * evaluations for one vault within 15 minutes lock that vault's layer routes
 * and evidence-bearing approvals for 15 minutes. Counted only after the vault
 * is known to belong to the caller, so nobody can lock someone else's vault.
 */
import { LOCKOUT } from './types.js';

export type LockState = { locked: false } | { locked: true; retryAfterSeconds: number };
export interface Lockout {
  check(key: string): LockState;
  /** Records one failure; returns the state after it. */
  fail(key: string): LockState;
}
export interface LockoutOptions { now?: () => number; failures?: number; windowMs?: number; lockMs?: number; maxKeys?: number }

export function createLockout(options: LockoutOptions = {}): Lockout {
  const now = options.now ?? Date.now;
  const limit = options.failures ?? LOCKOUT.failures;
  const windowMs = options.windowMs ?? LOCKOUT.windowMs;
  const lockMs = options.lockMs ?? LOCKOUT.lockMs;
  const maxKeys = options.maxKeys ?? 10_000;
  const state = new Map<string, { failures: number[]; lockedUntil: number }>();
  const check = (key: string): LockState => {
    const entry = state.get(key);
    const at = now();
    if (!entry) return { locked: false };
    if (entry.lockedUntil > at) return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - at) / 1000)) };
    entry.failures = entry.failures.filter(time => at - time < windowMs);
    if (!entry.failures.length) state.delete(key);
    return { locked: false };
  };
  return {
    check,
    fail(key) {
      const at = now();
      const entry = state.get(key) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter(time => at - time < windowMs);
      entry.failures.push(at);
      if (entry.failures.length >= limit) { entry.lockedUntil = at + lockMs; entry.failures = []; }
      state.delete(key); state.set(key, entry);
      while (state.size > maxKeys) state.delete(state.keys().next().value as string);
      return check(key);
    },
  };
}
