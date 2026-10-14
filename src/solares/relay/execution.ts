import type { QuoteStep } from './model';
import { SolanaSendError, possiblySentSignature } from '../wallet/solanaSend';

/**
 * The Solana deposit through the wallet's `sendSolanaTransaction` (wallet/types.ts). A broadcast whose answer
 * was lost still yields its signature, so the deposit is recorded, indexed and followed instead of left without
 * a hash. Otherwise `maybeSent` says whether it may have reached the network: only an unknown outcome without a
 * signature (a wallet that broadcast itself) may have; every other rejection sent nothing.
 */
export async function sendSolanaDeposit(send: () => Promise<string>): Promise<{ signature: string } | { error: unknown; maybeSent: boolean }> {
  try { return { signature: await send() }; }
  catch (error) {
    const signature = possiblySentSignature(error);
    if (signature) return { signature };
    return { error, maybeSent: error instanceof SolanaSendError && error.submitted === 'unknown' };
  }
}

export function assertApprovalReceipt(hash: string, receipt: { status: string; transactionHash: string }): void {
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('The approval was replaced or cancelled. Review a new route.');
  if (receipt.status !== 'success') throw new Error('The stablecoin approval failed on-chain.');
}

/** A bounded signature sequence. Settlement tracking never retains a signing callback. */
export async function submitRelayDeposit(options: {
  steps: QuoteStep[];
  assertCanSign(): void;
  send(step: QuoteStep): Promise<string>;
  confirmApproval(hash: string): Promise<void>;
  indexDeposit(hash: string): Promise<void>;
}): Promise<string> {
  const ids = options.steps.map(step => step.id).join(',');
  if (ids !== 'deposit' && ids !== 'approve,deposit') throw new Error('Unsupported transaction sequence.');
  for (const step of options.steps) {
    options.assertCanSign();
    const hash = await options.send(step);
    if (step.id === 'approve') {
      // A failed/expired receipt stops this function. A late receipt has no path to another signature.
      await options.confirmApproval(hash);
    } else {
      await options.indexDeposit(hash);
      return hash;
    }
  }
  throw new Error('No deposit was submitted.');
}
