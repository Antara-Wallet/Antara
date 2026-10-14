import {
  serializeTransaction,
  keccak256,
  hashTypedData,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { signHash } from "./vault";
import {
  buildSwap,
  getTxParams,
  broadcastTx,
  getTxReceipt,
  type SwapChain,
  type SwapQuote,
  type Permit2TypedData,
  type PermitInput,
} from "./api";

/**
 * Swap orchestration. The private key never leaves the Rust vault core: we build
 * the tx here with viem, hand the 32-byte signing digest to Rust (`signHash`),
 * reassemble the signed tx, and broadcast through the backend (which holds the
 * RPC key). Same pattern for the Permit2 EIP-712 signature.
 */

export type SwapPhase =
  | "quoting"
  | "approving"
  | "signing-permit"
  | "swapping"
  | "confirming"
  | "done"
  | "error";

export interface SwapResult {
  hash: Hex;
  status: "success" | "reverted";
  quote: SwapQuote;
}

const GAS_FALLBACK = 600_000n;

/** Split a 65-byte r‖s‖v signature (v in {27,28}) into viem's r/s/yParity. */
function splitSig(sig: string): { r: Hex; s: Hex; yParity: number } {
  const h = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (h.length !== 130) throw new Error("expected a 65-byte signature");
  return {
    r: `0x${h.slice(0, 64)}`,
    s: `0x${h.slice(64, 128)}`,
    yParity: parseInt(h.slice(128, 130), 16) - 27,
  };
}

export async function signAndBroadcast(
  chain: SwapChain,
  accountIndex: number,
  from: Hex,
  to: Hex,
  value: bigint,
  data: Hex
): Promise<Hex> {
  const p = await getTxParams(chain, from, to, value.toString(), data);
  const estimated = BigInt(p.gas);
  const gas = estimated > 0n ? (estimated * 12n) / 10n : GAS_FALLBACK; // +20% buffer

  const tx: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: p.chainId,
    nonce: p.nonce,
    to,
    value,
    data,
    gas,
    maxFeePerGas: BigInt(p.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
  };

  const digest = keccak256(serializeTransaction(tx));
  const sig = await signHash(accountIndex, digest);
  const signed = serializeTransaction(tx, splitSig(sig));
  const { hash } = await broadcastTx(chain, signed);
  return hash;
}

export async function waitForReceipt(
  chain: SwapChain,
  hash: Hex,
  timeoutMs = 90_000
): Promise<"success" | "reverted"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { receipt } = await getTxReceipt(chain, hash);
    if (receipt) return receipt.status;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("timed out waiting for confirmation");
}

async function signPermit(
  accountIndex: number,
  td: Permit2TypedData,
  spender: Hex
): Promise<PermitInput> {
  const digest = hashTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      details: {
        token: td.message.details.token,
        amount: BigInt(td.message.details.amount),
        expiration: td.message.details.expiration,
        nonce: td.message.details.nonce,
      },
      spender: td.message.spender,
      sigDeadline: BigInt(td.message.sigDeadline),
    },
  });
  const signature = await signHash(accountIndex, digest);
  return {
    token: td.message.details.token,
    amount: td.message.details.amount,
    expiration: td.message.details.expiration,
    nonce: td.message.details.nonce,
    spender,
    sigDeadline: td.message.sigDeadline,
    signature,
  };
}

export async function executeSwap(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    from: Hex;
    tokenIn: string;
    tokenOut: string;
    amountIn: string; // raw smallest unit
    slippageBps?: number;
  },
  onPhase?: (phase: SwapPhase) => void
): Promise<SwapResult> {
  const { chain, accountIndex, from, tokenIn, tokenOut, amountIn } = opts;
  const slippageBps = opts.slippageBps ?? 50;
  const phase = (p: SwapPhase) => onPhase?.(p);

  try {
    phase("quoting");
    let build = await buildSwap({ chain, tokenIn, tokenOut, amountIn, recipient: from, slippageBps });

    if (build.kind === "permit_required") {
      // 1) One-time ERC-20 approve to Permit2, if needed.
      if (build.needsErc20Approve && build.approveTx) {
        phase("approving");
        const h = await signAndBroadcast(
          chain,
          accountIndex,
          from,
          build.approveTx.to,
          BigInt(build.approveTx.value),
          build.approveTx.data
        );
        await waitForReceipt(chain, h);
      }
      // 2) Sign the gasless Permit2 allowance, then rebuild with the signature.
      phase("signing-permit");
      const permit = await signPermit(accountIndex, build.permit2.typedData, build.permit2.typedData.message.spender);
      build = await buildSwap({ chain, tokenIn, tokenOut, amountIn, recipient: from, slippageBps, permit });
      if (build.kind !== "tx") throw new Error("could not build swap after permit");
    }

    // 3) Sign + broadcast the swap itself.
    phase("swapping");
    const hash = await signAndBroadcast(
      chain,
      accountIndex,
      from,
      build.to,
      BigInt(build.value),
      build.data
    );

    phase("confirming");
    const status = await waitForReceipt(chain, hash);
    phase(status === "success" ? "done" : "error");
    return { hash, status, quote: build.quote };
  } catch (e) {
    phase("error");
    throw e;
  }
}
