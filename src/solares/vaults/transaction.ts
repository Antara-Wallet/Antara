import type { Hex } from 'viem';
import { isNetworkError } from '../ui/friendlyError';
import { SOLANA_UNCONFIRMED_TEXT, SolanaTransactionExpiredError, confirmSolanaSignature, type ConfirmSolanaOptions, type SolanaStatusRpc } from '../wallet/solanaConfirm';
import { SolanaSendError } from '../wallet/solanaSend';

/** Retain broadcast evidence if a receipt lookup or post-confirmation refresh fails. */
export class VaultTransactionError extends Error {
  constructor(message: string, readonly signature: string, readonly confirmed: boolean, readonly outcome: 'unknown' | 'reverted' | 'verification-failed' = confirmed ? 'verification-failed' : 'unknown') { super(message); this.name = 'VaultTransactionError'; }
}
/** A transport failure after a broadcast is worded calmly: the UI pairs it with "do not repeat it", never with "try again". */
const UNCONFIRMED_TEXT = 'The network has not confirmed this transaction yet. It may still go through.';
const UNVERIFIED_TEXT = 'The transaction is confirmed, but its result could not be read yet.';
export async function preserveVaultTransaction<T>(signature: string, operation: () => Promise<T>, confirmed = false): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof VaultTransactionError) throw error;
    const raw = error instanceof Error ? error.message : '';
    throw new VaultTransactionError(raw && !isNetworkError(raw) ? raw : confirmed ? UNVERIFIED_TEXT : UNCONFIRMED_TEXT, signature, confirmed);
  }
}

/**
 * Sends one Solana vault transaction with `send` (simulation, then the wallet: vaults/preflight.ts)
 * and settles it by polling (wallet/solanaConfirm.ts), never by websockets. Resolves with the
 * confirmed signature. Once the wallet has signed, the signature is never lost:
 * - a broadcast whose answer was lost is followed by its signature;
 * - reverted on-chain: VaultTransactionError (confirmed, 'reverted');
 * - not settled: VaultTransactionError (unconfirmed, 'unknown') with the signature: never repeat it blindly;
 * - expired (never landed, never can): SolanaTransactionExpiredError: nothing moved, a fresh try is safe.
 */
export async function settleSolanaVaultTransaction(
  rpc: SolanaStatusRpc, lifetime: { blockhash: string; lastValidBlockHeight: number }, send: () => Promise<string>,
  options: Partial<Omit<ConfirmSolanaOptions, 'rpc' | 'signature' | 'blockhash' | 'lastValidBlockHeight'>> = {},
): Promise<string> {
  let signature: string;
  try { signature = await send(); }
  catch (error) {
    if (!(error instanceof SolanaSendError) || error.submitted !== 'unknown') throw error;
    // The wallet broadcast itself and its answer was lost: there is no signature to follow.
    if (!error.signature) throw new VaultTransactionError(error.message, '', false);
    signature = error.signature;
  }
  const result = await confirmSolanaSignature({ ...options, rpc, signature, blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
  if (result.outcome === 'confirmed') return signature;
  if (result.outcome === 'reverted') throw new VaultTransactionError('The Solana transaction failed on-chain.', signature, true, 'reverted');
  if (result.outcome === 'expired') throw new SolanaTransactionExpiredError(signature);
  throw new VaultTransactionError(SOLANA_UNCONFIRMED_TEXT, signature, false, 'unknown');
}

export async function waitForVaultReceipt<R extends { transactionHash: string; status: 'success' | 'reverted' }>(
  signature: Hex, chainId: number,
  client: { getChainId: () => Promise<number>; waitForTransactionReceipt: (parameters: { hash: Hex; timeout: number; checkReplacement: false }) => Promise<R> },
): Promise<R> {
  return preserveVaultTransaction(signature, async () => {
    const assertChain = async () => {
      if (await client.getChainId() !== chainId) throw new Error('The wallet network changed. Check this transaction on its original network before retrying.');
    };
    await assertChain();
    // A confirmed cancellation or replacement must never masquerade as a deposit or approval.
    const receipt = await client.waitForTransactionReceipt({ hash: signature, timeout: 60_000, checkReplacement: false });
    await assertChain();
    if (receipt.transactionHash.toLowerCase() !== signature.toLowerCase()) throw new Error('The receipt belongs to a different transaction. Vault confirmation remains unresolved.');
    if (receipt.status !== 'success') throw new VaultTransactionError('The vault transaction reverted on-chain.', signature, true, 'reverted');
    return receipt;
  });
}
