import { encodeFunctionData, isAddress, parseUnits, type Hex } from "viem";
import { signAndBroadcast, waitForReceipt } from "./swap";
import type { SwapChain } from "./api";

/**
 * Plain asset transfer. Native sends carry value + empty data; ERC-20 sends call
 * `transfer(to, amount)` on the token. Signing happens in the Rust vault core via
 * the shared signAndBroadcast path — the key never leaves it.
 */

export type SendPhase = "signing" | "confirming" | "done" | "error";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface SendParams {
  chain: SwapChain;
  accountIndex: number;
  from: Hex;
  to: string;
  tokenAddress: string | null; // null = native coin
  amount: string; // human-readable units
  decimals: number;
}

export interface SendResult {
  hash: Hex;
  status: "success" | "reverted";
}

export async function sendAsset(
  p: SendParams,
  onPhase?: (phase: SendPhase) => void
): Promise<SendResult> {
  if (!isAddress(p.to)) throw new Error("Invalid recipient address");
  const raw = parseUnits(p.amount, p.decimals);
  if (raw <= 0n) throw new Error("Amount must be greater than 0");

  let to: Hex;
  let value: bigint;
  let data: Hex;
  if (p.tokenAddress && isAddress(p.tokenAddress)) {
    to = p.tokenAddress;
    value = 0n;
    data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [p.to as Hex, raw],
    });
  } else {
    to = p.to as Hex;
    value = raw;
    data = "0x";
  }

  onPhase?.("signing");
  const hash = await signAndBroadcast(p.chain, p.accountIndex, p.from, to, value, data);
  onPhase?.("confirming");
  const status = await waitForReceipt(p.chain, hash);
  onPhase?.(status === "success" ? "done" : "error");
  return { hash, status };
}
