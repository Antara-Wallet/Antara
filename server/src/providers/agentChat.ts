import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "../config.js";

/**
 * Hosted agent chat. ARK runs the LLM (our key, gated by $ARK holdings) but never
 * the keys: the model can READ freely, and any spend tool it calls is handed back
 * to the client, which signs with the agent's key and runs it past the co-signer
 * policy. This module just defines the tools + system prompt and forwards the
 * conversation to Anthropic.
 */

const TOOLS = [
  {
    name: "get_balance",
    description: "Get the agent vault's token balances and total USD value.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_policy",
    description:
      "Get the vault's spending policy: per-transaction cap and allowlist. Read this before proposing any payment.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pay",
    description:
      "Pay from the vault. The co-signer only approves it within the policy; the owner confirms in the app before it executes.",
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
        tokenOut: { type: "string", description: "ERC-20 contract address to receive" },
        amount: { type: "string", description: "Amount of ETH to swap" },
      },
      required: ["tokenOut", "amount"],
    },
  },
];

function systemPrompt(vaultAddress: string): string {
  return `You are an AI agent that operates an ARK vault on Base. Vault: ${vaultAddress}.

Your spending is gated by a policy the owner set (per-transaction cap, allowlist),
enforced by ARK's co-signer. You cannot exceed it, and you should not try to.

Rules:
- Before proposing a payment, call get_policy and get_balance. Never assume.
- Stay within the cap and only pay allowlisted recipients if an allowlist is set.
- If a payment is denied, do not retry the same thing or split it to evade the
  limit. Explain to the owner what was blocked and what would unblock it.
- Every pay/swap is confirmed by the owner in the app before it executes. Be
  clear about exactly what you are about to do (amount, token, recipient).
- Be concise and practical. You are managing real money.`;
}

export async function agentChat(opts: {
  vaultAddress: string;
  messages: unknown[];
}): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt(opts.vaultAddress),
      tools: TOOLS,
      messages: opts.messages,
    }),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `anthropic ${res.status}`);
  }
  return json;
}
