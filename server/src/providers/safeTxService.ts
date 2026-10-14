import SafeApiKit from "@safe-global/api-kit";
import { type Address, type Hex } from "viem";
import { CHAIN_IDS, SAFE_API_KEY } from "../config.js";
import type { ChainId } from "./uniswap.js";
import type { SafeTxData, OwnerSignature } from "./safe.js";

/**
 * Safe Transaction Service coordination (api-kit). This is the OFF-CHAIN mailbox
 * where a multi-owner vault collects signatures before anyone pays gas. The
 * device proposes a SafeTx with its own Rust signature; other owners (e.g. the
 * FIDO2 co-signer) fetch it, sign the same EIP-712 hash, and confirm. Once the
 * gathered confirmations reach the threshold, any owner can encode + broadcast
 * `execTransaction` (see safe.ts `encodeVaultExec`). Keys still never leave Rust.
 *
 * The service only stores hashes + signatures — it never holds funds or keys.
 */

export type VaultChain = ChainId;

function apiKit(chain: VaultChain): SafeApiKit {
  const chainId = CHAIN_IDS[chain];
  if (chainId == null) throw new Error(`unknown chain: ${chain}`);
  if (!SAFE_API_KEY) throw new Error("SAFE_API_KEY not set");
  return new SafeApiKit({ chainId: BigInt(chainId), apiKey: SAFE_API_KEY });
}

/** A pending SafeTx awaiting more owner confirmations. */
export interface PendingVaultTx {
  safeTxHash: Hex;
  to: Address;
  value: string;
  data: Hex;
  operation: number;
  // Canonical gas params — needed to recreate the exact SafeTx (stable hash).
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
  confirmationsRequired: number;
  confirmations: { owner: Address; signature: Hex }[];
  isExecuted: boolean;
  isReady: boolean; // confirmations >= threshold
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Publish a SafeTx to the service with the proposer's signature. The proposer
 * must be an owner; their signature is the first confirmation.
 */
export async function proposeVaultTx(
  chain: VaultChain,
  safeAddress: Address,
  safeTxHash: Hex,
  safeTxData: SafeTxData,
  proposer: OwnerSignature
): Promise<void> {
  const kit = apiKit(chain);
  await kit.proposeTransaction({
    safeAddress,
    safeTxHash,
    senderAddress: proposer.signer,
    senderSignature: proposer.data,
    safeTransactionData: {
      to: safeTxData.to,
      value: safeTxData.value,
      data: safeTxData.data,
      operation: safeTxData.operation,
      safeTxGas: safeTxData.safeTxGas,
      baseGas: safeTxData.baseGas,
      gasPrice: safeTxData.gasPrice,
      gasToken: safeTxData.gasToken,
      refundReceiver: safeTxData.refundReceiver,
      nonce: safeTxData.nonce,
    },
  });
}

/** Add another owner's signature to an already-proposed SafeTx. */
export async function confirmVaultTx(
  chain: VaultChain,
  safeTxHash: Hex,
  signature: Hex
): Promise<void> {
  const kit = apiKit(chain);
  await kit.confirmTransaction(safeTxHash, signature);
}

/** Full state of a single proposed SafeTx, including gathered signatures. */
export async function getVaultTx(
  chain: VaultChain,
  safeTxHash: Hex
): Promise<PendingVaultTx> {
  const kit = apiKit(chain);
  const tx = await kit.getTransaction(safeTxHash);
  return toPending(tx);
}

/** List SafeTxs still waiting on confirmations for a vault. */
export async function listPendingVaultTxs(
  chain: VaultChain,
  safeAddress: Address
): Promise<PendingVaultTx[]> {
  const kit = apiKit(chain);
  const res = await kit.getPendingTransactions(safeAddress);
  return res.results.map(toPending);
}

/**
 * Gather the confirmations of a ready SafeTx into the OwnerSignature[] that
 * `encodeVaultExec` consumes to build the on-chain `execTransaction`.
 */
export async function collectSignatures(
  chain: VaultChain,
  safeTxHash: Hex
): Promise<OwnerSignature[]> {
  const tx = await getVaultTx(chain, safeTxHash);
  return tx.confirmations.map((c) => ({ signer: c.owner, data: c.signature }));
}

function toPending(tx: {
  safeTxHash: string;
  to: string;
  value: string;
  data?: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver?: string;
  nonce: string;
  confirmationsRequired: number;
  confirmations?: { owner: string; signature: string }[];
  isExecuted: boolean;
}): PendingVaultTx {
  const confirmations = (tx.confirmations ?? []).map((c) => ({
    owner: c.owner as Address,
    signature: c.signature as Hex,
  }));
  return {
    safeTxHash: tx.safeTxHash as Hex,
    to: tx.to as Address,
    value: tx.value,
    data: (tx.data ?? "0x") as Hex,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas,
    baseGas: tx.baseGas,
    gasPrice: tx.gasPrice,
    gasToken: tx.gasToken as Address,
    refundReceiver: (tx.refundReceiver ?? ZERO_ADDRESS) as Address,
    nonce: Number(tx.nonce),
    confirmationsRequired: tx.confirmationsRequired,
    confirmations,
    isExecuted: tx.isExecuted,
    isReady: confirmations.length >= tx.confirmationsRequired,
  };
}
