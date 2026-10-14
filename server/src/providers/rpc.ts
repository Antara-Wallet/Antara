import { type Address, type Hex } from "viem";
import { getRpcClient, type ChainId } from "./uniswap.js";

/**
 * Thin RPC helpers so the desktop app never needs the Alchemy key. The frontend
 * builds + signs the tx (signing happens in the Rust vault core), then sends the
 * pre-signed raw tx here for broadcast. We never see a private key.
 */

export interface TxParams {
  chainId: number;
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string; // estimated gas limit
}

export async function getTxParams(
  chain: ChainId,
  from: Address,
  to: Address,
  value: bigint,
  data: Hex
): Promise<TxParams> {
  const client = getRpcClient(chain);
  const [chainId, nonce, fees, gas] = await Promise.all([
    client.getChainId(),
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.estimateFeesPerGas(),
    client
      .estimateGas({ account: from, to, value, data })
      .catch(() => 0n), // estimation can fail pre-approval; frontend falls back
  ]);
  return {
    chainId,
    nonce,
    maxFeePerGas: (fees.maxFeePerGas ?? 0n).toString(),
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? 0n).toString(),
    gas: gas.toString(),
  };
}

export async function broadcastRaw(chain: ChainId, raw: Hex): Promise<string> {
  return getRpcClient(chain).sendRawTransaction({ serializedTransaction: raw });
}

export async function getReceipt(
  chain: ChainId,
  hash: Hex
): Promise<{ status: "success" | "reverted"; blockNumber: string } | null> {
  try {
    const r = await getRpcClient(chain).getTransactionReceipt({ hash });
    return { status: r.status, blockNumber: r.blockNumber.toString() };
  } catch {
    return null; // not mined yet
  }
}
