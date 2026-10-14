// Turn raw chain / RPC / viem errors into short, human messages for the UI.
// viem throws multi-line dumps (URL, request body, details…) that should never
// reach the user verbatim.

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// `network` and `gasSymbol` name the chain the failed transaction targeted (for
// example "Base" and "ETH"). Without them the message stays chain-neutral rather
// than guessing a network.
export function friendlyError(
  e: unknown,
  ctx?: { fundAddress?: string; network?: string; gasSymbol?: string }
): string {
  const msg = e instanceof Error ? e.message : String(e);
  const low = msg.toLowerCase();

  if (low.includes("insufficient funds")) {
    const who = ctx?.fundAddress ? ` (${short(ctx.fundAddress)})` : "";
    const gas = ctx?.gasSymbol ?? "native gas token";
    const where = ctx?.network ? ` on ${ctx.network}` : "";
    return `Not enough ${gas}${where} to cover gas. Add a little ${gas} to your wallet${who}, then try again.`;
  }
  if (low.includes("user rejected") || low.includes("user denied") || low.includes("not allowed") || low.includes("cancel")) {
    return "Request cancelled.";
  }
  if (low.includes("failed to fetch") || low.includes("networkerror") || low.includes("network error") || low.includes("timeout") || low.includes("etimedout")) {
    return "Can't reach the network right now. Check your connection and try again.";
  }
  if (low.includes("nonce")) {
    return "Transaction got out of sync. Please try again in a moment.";
  }
  if (low.includes("reverted") || low.includes("execution reverted")) {
    return "The transaction was rejected on-chain. Please try again.";
  }

  // Fallback: first line only, trimmed — never the giant viem dump.
  return msg.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 160) || "Something went wrong. Please try again.";
}
