/**
 * The one way ANTARA learns whether a Solana transaction it sent landed. No websockets.
 *
 * Every Solana send path (vault creation, deposits, proposals, approvals, executions and
 * direct transfers) confirms through `confirmSolanaSignature`. It polls `getSignatureStatuses`
 * (with transaction history) and the confirmed block height over HTTP, through the same RPC the
 * transaction was sent with (ANTARA's proxy in the apps), and compares the height with the
 * blockhash's lastValidBlockHeight.
 *
 * Outcomes:
 * - confirmed: seen at the target commitment without an error.
 * - reverted:  seen at the target commitment with an error (network fees may have been charged).
 * - expired:   definitively did not land: never seen, the block height passed lastValidBlockHeight,
 *              every check through a grace window (30 s) after that still answered "absent", and
 *              the RPC answered that the blockhash is no longer valid (an unanswered or impossible
 *              check proves nothing). A fresh transaction is then safe. A signature a wallet
 *              broadcast itself (noteWalletBroadcast) is never expired: that wallet may have
 *              replaced the blockhash ANTARA built it with.
 * - unknown:   not settled (the RPC could not answer, or the signature was seen below the target
 *              commitment and never reached it). Never retried automatically.
 * Never 'expired' once any read has seen the signature.
 *
 * Incidents (2026-10-13):
 * - Privy's embedded signAndSendTransaction broadcast, then waited 10 s on a websocket
 *   signatureNotifications subscription that the public endpoint never answered for an
 *   already-confirmed signature: "Transaction confirmation timed out" after the broadcast, and
 *   the signature was lost.
 * - web3.js confirmTransaction (block height strategy) reported a finalized Squads creation as
 *   "block height exceeded".
 */
import type { Connection, SignatureStatus } from '@solana/web3.js';

export type SolanaConfirmation =
  | { outcome: 'confirmed'; slot: number | null }
  | { outcome: 'reverted'; err: unknown; slot: number | null }
  | { outcome: 'expired' }
  /** `seen`: a read reported the signature (below the target commitment) at least once. */
  | { outcome: 'unknown'; seen: boolean };
export type SolanaConfirmationOutcome = SolanaConfirmation['outcome'];

/** What the poller reads. A web3.js Connection satisfies it. */
export type SolanaStatusRpc = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'> & Partial<Pick<Connection, 'isBlockhashValid'>>;

/** The transaction definitively did not land, so nothing moved. */
export const SOLANA_EXPIRED_TEXT = 'This transaction did not land on Solana before it expired. Nothing moved, so it is safe to try again.';
/** Polling ended without an answer: it may still land. */
export const SOLANA_UNCONFIRMED_TEXT = 'Solana has not confirmed this transaction yet. It may still go through.';

/** A sent transaction that definitively did not land (outcome 'expired'). Nothing moved. */
export class SolanaTransactionExpiredError extends Error {
  constructor(readonly signature: string) { super(SOLANA_EXPIRED_TEXT); this.name = 'SolanaTransactionExpiredError'; }
}

export interface ConfirmSolanaOptions {
  rpc: SolanaStatusRpc;
  signature: string;
  /** The transaction's blockhash. Only the RPC's answer that it is no longer valid (isBlockhashValid) proves expiry: without it, never expired. */
  blockhash?: string | null;
  /** The blockhash's lastValidBlockHeight. Without it a transaction is never reported expired. */
  lastValidBlockHeight?: number | null;
  /** Target commitment. Default 'confirmed' ('finalized' also satisfies it). */
  commitment?: 'confirmed' | 'finalized';
  /** Poll interval. Default 1.5 s. */
  intervalMs?: number;
  /** Re-checks after the block height passes lastValidBlockHeight. Default 30 s. */
  graceMs?: number;
  /** Gives up as unknown when expiry was never observed by then. Default 150 s. */
  timeoutMs?: number;
  /** One RPC read that takes longer counts as unanswered. Default 10 s. */
  readTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Consecutive "absent" answers needed at the end of the grace window before 'expired'. */
const MIN_ABSENT_READS = 3;

/**
 * Signatures a wallet broadcast itself (solanaSend.ts sendThroughWallet, for wallets that cannot sign only).
 * Such a wallet may refresh the blockhash before sending, so the lifetime ANTARA built the transaction with
 * says nothing about it: these are never reported expired, only confirmed, reverted or unknown.
 */
const walletBroadcasts = new Set<string>();
export function noteWalletBroadcast(signature: string): void {
  if (!signature) return;
  walletBroadcasts.add(signature);
  // Bounded: this session's sends only.
  if (walletBroadcasts.size > 500) walletBroadcasts.delete(walletBroadcasts.values().next().value as string);
}
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safeHeight = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
type Read<T> = { ok: true; value: T } | { ok: false };
async function attempt<T>(read: () => Promise<T>, timeoutMs: number): Promise<Read<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC read timed out.')), timeoutMs); });
    return { ok: true, value: await Promise.race([read(), timeout]) };
  } catch { return { ok: false }; }
  finally { clearTimeout(timer); }
}
/** 0 processed, 1 confirmed, 2 finalized. Older nodes omit confirmationStatus: only rooted (confirmations null) counts as more than processed. */
function commitmentLevel(status: SignatureStatus): number {
  switch (status.confirmationStatus) {
    case 'finalized': return 2;
    case 'confirmed': return 1;
    case 'processed': return 0;
    default: return status.confirmations === null ? 2 : 0;
  }
}

export async function confirmSolanaSignature(options: ConfirmSolanaOptions): Promise<SolanaConfirmation> {
  const { rpc, signature } = options;
  const lastValid = walletBroadcasts.has(signature) ? null : safeHeight(options.lastValidBlockHeight);
  const target = options.commitment === 'finalized' ? 2 : 1;
  const now = options.now ?? Date.now, sleep = options.sleep ?? defaultSleep;
  const intervalMs = options.intervalMs ?? 1_500, graceMs = options.graceMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 150_000, readTimeoutMs = options.readTimeoutMs ?? 10_000;
  const start = now();
  let seen = false;
  let graceStart: number | null = null;
  let absentReads = 0;

  for (;;) {
    options.signal?.throwIfAborted();
    const [statusRead, heightRead] = await Promise.all([
      attempt(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }), readTimeoutMs),
      lastValid === null ? Promise.resolve<Read<number>>({ ok: false }) : attempt(() => rpc.getBlockHeight('confirmed'), readTimeoutMs),
    ]);
    const statuses = statusRead.ok && Array.isArray(statusRead.value?.value) ? statusRead.value.value : null;
    const status = statuses?.[0] ?? null;
    if (status) {
      seen = true;
      if (commitmentLevel(status) >= target) {
        const slot = safeHeight(status.slot);
        return status.err === null || status.err === undefined ? { outcome: 'confirmed', slot } : { outcome: 'reverted', err: status.err, slot };
      }
    }
    const height = heightRead.ok ? safeHeight(heightRead.value) : null;
    if (graceStart === null && lastValid !== null && height !== null && height > lastValid) graceStart = now();
    if (graceStart !== null) {
      // Only a clean answer (the RPC answered, without the signature) counts as absent.
      absentReads = statuses && !status ? absentReads + 1 : 0;
      const elapsed = now() - graceStart;
      if (seen && elapsed >= graceMs) return { outcome: 'unknown', seen: true };
      if (!seen && elapsed >= graceMs && absentReads >= MIN_ABSENT_READS) {
        const valid = options.blockhash && rpc.isBlockhashValid
          ? await attempt(() => rpc.isBlockhashValid!(options.blockhash!, { commitment: 'confirmed' }), readTimeoutMs)
          : { ok: false as const };
        const answer = valid.ok ? valid.value?.value : undefined;
        // Only the RPC's own "no longer valid" proves expiry.
        if (answer === false) return { outcome: 'expired' };
        // An RPC that still calls the blockhash valid disagrees with its block height: keep polling.
        if (answer === true) { graceStart = null; absentReads = 0; }
        // A check that failed or cannot be made proves nothing: keep checking, then unknown.
        else if (elapsed >= graceMs * 2) return { outcome: 'unknown', seen: false };
      } else if (elapsed >= graceMs * 2) return { outcome: 'unknown', seen };
    }
    if (graceStart === null && now() - start >= timeoutMs) return { outcome: 'unknown', seen };
    await sleep(intervalMs);
  }
}
