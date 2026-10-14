import {
  parseUnits,
  encodeFunctionData,
  isAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  buildVaultTx,
  cosignVaultTx,
  buildVaultExec,
  getTxParams,
  broadcastTx,
  getTxReceipt,
  buildSwap,
  getTokenInfo,
  type SwapChain,
  type ChatResponse,
} from "./api";

// --- Bring-your-own-key chat: call Anthropic directly from the app -----------

const BYO_MODEL = "claude-sonnet-4-20250514";

const TOOLS = [
  { name: "get_balance", description: "Get the agent vault's token balances and total USD value.", input_schema: { type: "object", properties: {} } },
  { name: "get_policy", description: "Get the vault's spending policy (per-transaction cap, allowlist). Read before proposing any payment.", input_schema: { type: "object", properties: {} } },
  {
    name: "pay",
    description: "Pay from the vault. The co-signer only approves within policy; the owner confirms in the app first.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address (0x...)" },
        amount: { type: "string", description: 'Human amount, e.g. "0.01"' },
        token: { type: "string", description: '"native"/"eth" (default) or an ERC-20 address' },
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "swap",
    description: "Swap ETH from the vault for a token; output returns to the vault.",
    input_schema: {
      type: "object",
      properties: {
        tokenOut: { type: "string", description: "ERC-20 address to receive" },
        amount: { type: "string", description: "Amount of ETH to swap" },
      },
      required: ["tokenOut", "amount"],
    },
  },
];

function systemPrompt(vault: string): string {
  return `You are an AI agent operating an ARK vault on Base. Vault: ${vault}.
Your spending is gated by a policy the owner set (per-transaction cap, allowlist),
enforced by ARK's co-signer; you cannot exceed it. Before proposing a payment,
call get_policy and get_balance. Stay within the cap and allowlist. If a payment
is denied, do not retry or split it to evade the limit — explain what was blocked.
Every pay/swap is confirmed by the owner in the app before it executes. Be concise.`;
}

/** Call Anthropic directly with the user's own key (no ARK backend, no gate). */
export async function byoChat(
  apiKey: string,
  opts: { vaultAddress: string; messages: unknown[] }
): Promise<ChatResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey.trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: BYO_MODEL,
      max_tokens: 1024,
      system: systemPrompt(opts.vaultAddress),
      tools: TOOLS,
      messages: opts.messages,
    }),
  });
  const json = (await res.json()) as ChatResponse & { error?: { message?: string } };
  if (!res.ok) throw new Error(json?.error?.message ?? `anthropic ${res.status}`);
  return json;
}

/**
 * Client-side agent session for the hosted chat. Signs vault transactions with
 * the agent's key (held only in memory for the session) and runs them past the
 * co-signer policy. The key never leaves the app; ARK only runs the LLM.
 */

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export class PolicyDenied extends Error {
  constructor(public checks: { name: string; ok: boolean; detail: string }[]) {
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    super(`Denied by policy. ${failed.join("; ")}`);
    this.name = "PolicyDenied";
  }
}

export class AgentSession {
  account: PrivateKeyAccount;
  constructor(
    privateKey: Hex,
    public chain: SwapChain,
    public vault: Address
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  private async executeVaultTx(to: Address, value: string, data: Hex) {
    const { safeTxHash, safeTxData } = await buildVaultTx({
      chain: this.chain,
      safeAddress: this.vault,
      to,
      value,
      data,
    });
    const ownerSig = await this.account.sign({ hash: safeTxHash });
    const cosign = await cosignVaultTx({
      chain: this.chain,
      safeAddress: this.vault,
      safeTxHash,
      safeTxData,
      factors: {},
    });
    if (!cosign.ok || !cosign.signature) throw new PolicyDenied(cosign.policy.checks);

    const exec = await buildVaultExec({
      chain: this.chain,
      safeAddress: this.vault,
      safeTxData,
      signatures: [{ signer: this.address, data: ownerSig }, cosign.signature],
    });
    const hash = await this.signAndBroadcast(exec.to, BigInt(exec.value), exec.data);
    const status = await this.waitReceipt(hash);
    return { hash, status };
  }

  private async signAndBroadcast(to: Address, value: bigint, data: Hex): Promise<Hex> {
    const p = await getTxParams(this.chain, this.address, to, value.toString(), data);
    const estimated = BigInt(p.gas);
    const gas = estimated > 0n ? (estimated * 12n) / 10n : 600_000n;
    const signed = await this.account.signTransaction({
      type: "eip1559",
      chainId: p.chainId,
      nonce: p.nonce,
      to,
      value,
      data,
      gas,
      maxFeePerGas: BigInt(p.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
    });
    const { hash } = await broadcastTx(this.chain, signed);
    return hash;
  }

  private async waitReceipt(hash: Hex, timeoutMs = 90_000): Promise<"success" | "reverted"> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { receipt } = await getTxReceipt(this.chain, hash);
      if (receipt) return receipt.status;
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error("timed out waiting for confirmation");
  }

  async pay(args: { to: string; amount: string; token?: string }) {
    if (!isAddress(args.to)) throw new Error("recipient is not a valid address");
    const token = (args.token ?? "native").toLowerCase();
    if (token === "native" || token === "eth") {
      return this.executeVaultTx(args.to as Address, parseUnits(args.amount, 18).toString(), "0x");
    }
    if (!isAddress(token)) throw new Error("token must be 'native' or an ERC-20 address");
    const info = await getTokenInfo(this.chain, token);
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [args.to as Address, parseUnits(args.amount, info.decimals)],
    });
    return this.executeVaultTx(token as Address, "0", data);
  }

  async swap(args: { tokenOut: string; amount: string }) {
    const build = await buildSwap({
      chain: this.chain,
      tokenIn: "native",
      tokenOut: args.tokenOut,
      amountIn: parseUnits(args.amount, 18).toString(),
      recipient: this.vault,
      slippageBps: 50,
    });
    if (build.kind !== "tx") throw new Error("only ETH-in swaps from the vault are supported");
    return this.executeVaultTx(build.to, build.value, build.data);
  }
}
