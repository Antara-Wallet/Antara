/**
 * How ANTARA sends a Solana transaction: the wallet only signs, ANTARA reads the transaction id
 * from the signed bytes, broadcasts them once through its own HTTP RPC and returns the id at once.
 * Whether it landed is settled separately by polling (solanaConfirm.ts), never by websockets.
 *
 * Contract of `sendSolanaTransaction` (wallet/types.ts) built on this module:
 * - resolves with the signature once an RPC accepted the transaction;
 * - rejects with SolanaSendError { submitted: 'unknown', signature } when it may have been
 *   broadcast (follow that signature; never sign again blindly);
 * - rejects with SolanaSendError { submitted: false } when the RPC refused it before sending;
 * - any other rejection happened before anything was handed to the network (signing cancelled or
 *   refused, wallet or session changed, unreadable wallet output).
 */
import { SendTransactionError, VersionedTransaction, type Connection } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { SOLANA_SEND_UNKNOWN_TEXT } from '../ui/friendlyError';
import { noteWalletBroadcast } from './solanaConfirm';

export class SolanaSendError extends Error {
  constructor(message: string, readonly signature: string, readonly submitted: false | 'unknown') { super(message); this.name = 'SolanaSendError'; }
}

const NOT_SENT = 'Nothing was sent.';
const REFUSED_TEXT = `Solana refused this transaction before sending it, so nothing moved. Review it again. ${NOT_SENT}`;
const STALE_TEXT = `This transaction took too long to approve and expired before it was sent. Review it again. ${NOT_SENT}`;
const FEE_TEXT = `This wallet doesn’t have enough SOL for this transaction and its network fee. ${NOT_SENT}`;
const CHANGED_TEXT = `Your wallet changed this transaction after you reviewed it, so ANTARA did not send it. ${NOT_SENT}`;
const UNSIGNED_TEXT = `Your wallet did not sign this transaction. ${NOT_SENT}`;
const UNREADABLE_TEXT = `Your wallet returned a transaction ANTARA could not read. ${NOT_SENT}`;

const isZero = (bytes: Uint8Array) => bytes.every(byte => byte === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The complete signed wire bytes and the transaction id (the fee payer's signature) from a wallet's
 * output. Refuses a transaction whose message differs from the one requested (it was simulated and
 * reviewed exactly), a changed pre-existing signature (for example a new account's key), and any
 * missing required signature. A bare 64-byte signature (some WalletConnect wallets) is placed in
 * `signer`'s slot of the requested transaction.
 */
export function completeSignedTransaction(requested: Uint8Array, walletOutput: Uint8Array, signer: string): { bytes: Uint8Array; signature: string } {
  const original = VersionedTransaction.deserialize(requested);
  const required = original.message.header.numRequiredSignatures;
  let signed: VersionedTransaction;
  if (walletOutput.length === 64) {
    const index = original.message.staticAccountKeys.findIndex(key => key.toBase58() === signer);
    if (index < 0 || index >= required) throw new Error(UNSIGNED_TEXT);
    signed = VersionedTransaction.deserialize(requested);
    signed.signatures[index] = walletOutput;
  } else {
    try { signed = VersionedTransaction.deserialize(walletOutput); } catch { throw new Error(UNREADABLE_TEXT); }
    if (!sameBytes(signed.message.serialize(), original.message.serialize())) throw new Error(CHANGED_TEXT);
    if (original.signatures.some((signature, i) => !isZero(signature) && !sameBytes(signature, signed.signatures[i] ?? new Uint8Array()))) throw new Error(CHANGED_TEXT);
  }
  if (signed.signatures.length < required || signed.signatures.slice(0, required).some(isZero)) throw new Error(UNSIGNED_TEXT);
  return { bytes: signed.serialize(), signature: getBase58Decoder().decode(signed.signatures[0]) };
}

/**
 * The Solana node's own answers that come before it queues anything, matched only at the start of the
 * message: preflight (simulation) failure, signature or precompile verification, malformed input, an
 * unhealthy or lagging node, an unmet minimum context slot. Any other error answer, including any that
 * mentions "internal" or comes from a provider or gateway in front of the node (for example "Internal
 * error: invalid response from upstream node" or "Service not available after forward"), may follow a
 * forward to the leader, so it stays unknown.
 */
const REFUSAL_ANSWER = /^(?:Transaction simulation failed|Transaction signature verification failure|Transaction precompile verification failure|invalid transaction:|Invalid params|failed to deserialize|Node is unhealthy|Node is behind|Minimum context slot)/i;
/** The RPC refused before queueing the transaction (a definitive JSON-RPC refusal, or an HTTP 4xx from ANTARA's proxy or its upstream). */
function refusedBeforeSending(error: unknown): boolean {
  if (error instanceof SendTransactionError || (!!error && typeof error === 'object' && 'transactionMessage' in error)) {
    const answer = String((error as { transactionMessage?: unknown }).transactionMessage ?? '').trim();
    return !/internal/i.test(answer) && REFUSAL_ANSWER.test(answer);
  }
  return error instanceof Error && /^4(00|01|03|04|05|13|15|29)\b/.test(error.message);
}
function refusalText(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${(error as { transactionMessage?: unknown }).transactionMessage ?? ''}` : '';
  if (/blockhash not found|BlockhashNotFound/i.test(text)) return STALE_TEXT;
  if (/InsufficientFundsForFee|insufficient lamports|no record of a prior credit/i.test(text)) return FEE_TEXT;
  return REFUSED_TEXT;
}

/**
 * Broadcasts signed bytes once (preflight on: the RPC re-checks signatures and state) and returns
 * `signature`. Throws only SolanaSendError: `submitted: false` when the RPC refused before sending,
 * 'unknown' for anything else (a timeout or a lost answer may follow a successful broadcast).
 */
export async function broadcastSignedTransaction(rpc: Pick<Connection, 'sendRawTransaction'>, bytes: Uint8Array, signature: string): Promise<string> {
  let answer: string;
  try { answer = await rpc.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: 'confirmed' }); }
  catch (error) {
    const text = error instanceof Error ? `${error.message} ${(error as { transactionMessage?: unknown }).transactionMessage ?? ''}` : '';
    // A repeat of a transaction that already landed: it is on-chain under this signature.
    if (/already been processed|AlreadyProcessed/i.test(text)) return signature;
    if (refusedBeforeSending(error)) throw new SolanaSendError(refusalText(error), signature, false);
    throw new SolanaSendError(SOLANA_SEND_UNKNOWN_TEXT, signature, 'unknown');
  }
  if (answer !== signature) throw new SolanaSendError(SOLANA_SEND_UNKNOWN_TEXT, signature, 'unknown');
  return signature;
}

export interface SolanaSendDependencies {
  /** The wallet address that signs (and pays). */
  signer: string;
  /** Asks the wallet to sign only; resolves with its output (a signed transaction or a bare signature). */
  sign: (transaction: Uint8Array) => Promise<Uint8Array>;
  rpc: Pick<Connection, 'sendRawTransaction'>;
  /** Runs after signing, before the broadcast; throwing stops the send (nothing is broadcast). */
  beforeBroadcast?: () => void;
}
/** Sign with the wallet, then broadcast through ANTARA's RPC. Resolves with the signature as soon as the RPC accepts it. */
export async function signAndBroadcastSolanaTransaction(transaction: Uint8Array, dependencies: SolanaSendDependencies): Promise<string> {
  const output = await dependencies.sign(transaction);
  const { bytes, signature } = completeSignedTransaction(transaction, output, dependencies.signer);
  dependencies.beforeBroadcast?.();
  return broadcastSignedTransaction(dependencies.rpc, bytes, signature);
}

const USER_REJECTED = /user rejected|rejected the request|request rejected|user denied|cancell?ed|user exited|closed the modal/i;
/** A wallet's refusal to sign (nothing was sent). */
export function isUserRejection(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 4001) return true;
  return error instanceof Error && USER_REJECTED.test(error.message);
}
/**
 * For a wallet that can only sign and send itself (no `solana:signTransaction`): its own send,
 * without any confirmation wait. A refusal to sign passes through; any other failure may follow
 * a broadcast, whose signature ANTARA cannot know. The wallet may have replaced the blockhash, so
 * its signature is never reported expired (solanaConfirm.ts noteWalletBroadcast).
 */
export async function sendThroughWallet(send: () => Promise<string>): Promise<string> {
  try {
    const signature = await send();
    noteWalletBroadcast(signature);
    return signature;
  } catch (error) {
    if (isUserRejection(error)) throw error;
    throw new SolanaSendError(SOLANA_SEND_UNKNOWN_TEXT, '', 'unknown');
  }
}

/** Whether a connected wallet can sign without sending (every Privy embedded wallet and nearly every external one). */
export function walletCanSignOnly(wallet: { standardWallet?: { features?: object } | null }): boolean {
  try {
    const features = wallet.standardWallet?.features;
    if (Array.isArray(features)) return features.includes('solana:signTransaction');
    return !features || 'solana:signTransaction' in features;
  } catch { return true; }
}

/** The signature to follow when a send may have been broadcast, else null. */
export function possiblySentSignature(error: unknown): string | null {
  return error instanceof SolanaSendError && error.submitted === 'unknown' && error.signature ? error.signature : null;
}
