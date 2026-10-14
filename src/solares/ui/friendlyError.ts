/**
 * Turns raw provider, RPC and library errors into one short sentence for the UI.
 * Raw JSON-RPC bodies, HTTP status dumps and web3.js internals never reach users.
 */
/** A send whose outcome is not known: it may have landed, so this never invites a plain retry. */
export const SOLANA_SEND_UNKNOWN_TEXT = 'This transaction may have gone through. Check Activity or the explorer before trying again.';
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;
const UNREACHABLE = /indexed requests require|personal token|access forbidden|\b40[13]\s*:|failed to fetch|networkerror|fetch failed|load failed|ECONN|ETIMEDOUT|\b50[234]\b|-3260[0-9]|could not be reached|timed? ?out/i;
/** A transport or rate-limit failure (not an answer about the transaction itself). */
export function isNetworkError(raw: string): boolean {
  return RATE_LIMITED.test(raw) || UNREACHABLE.test(raw);
}
const RULES: ReadonlyArray<[RegExp, string]> = [
  [/user rejected|rejected the request|request rejected|user denied|cancell?ed/i, 'You cancelled the request in your wallet.'],
  // A confirmation wait that timed out or gave up after the broadcast (Privy: "Transaction
  // confirmation timed out"; web3.js: "… has expired: block height exceeded", "Transaction was not
  // confirmed in 30.00 seconds. It is unknown if it succeeded …"). Checked before the network rule.
  [/confirmation timed out|block height exceeded|TransactionExpired|signature \S+ has expired|was not confirmed in|unknown if it succeeded/i, SOLANA_SEND_UNKNOWN_TEXT],
  // Privy: the confirmation arrived with an error, so the transaction landed and failed.
  [/transaction confirmation failed/i, 'This transaction failed on Solana. Nothing moved; network fees may have been charged.'],
  // Raw Solana simulation failures (for example from a wallet's own preflight); vaults/preflight.ts words its own.
  [/InsufficientFundsForRent|insufficient funds for rent/i, 'Solana keeps an account only while it holds a small minimum of SOL, and this would leave one below it. Check the amount.'],
  [/InvalidAccountData|invalid account data for instruction/i, 'A token account this needs is missing. If you’re moving USDC, check that this wallet holds USDC on Solana.'],
  [RATE_LIMITED, 'Too many requests right now. Wait a few seconds and try again.'],
  [UNREACHABLE, 'Couldn’t reach the Solana network just now. Try again in a moment.'],
];
const LOOKS_RAW = /[{}[\]]|"jsonrpc"|\bat\s+\S+\s*\(|0x[0-9a-f]{40,}/i;

export function friendlyError(raw: string, fallback = 'Something went wrong. Try again in a moment.'): string {
  const text = raw.trim();
  if (!text) return fallback;
  for (const [pattern, message] of RULES) if (pattern.test(text)) return message;
  if (LOOKS_RAW.test(text) || text.length > 240) return fallback;
  return text;
}
