// Hide/unhide portfolio tokens. Two sources of hiding:
//  1) a conservative spam heuristic (no price + URL/scam-y name) for obvious
//     airdrop junk, and
//  2) manual user hides.
// Manual "show" overrides the heuristic so a real token never gets stuck hidden.
// Lives in localStorage (no key material), keyed by chain:address.

const KEY = "ark.tokenMeta.v1";

interface Store {
  hidden: string[];
  shown: string[];
}

export interface TokenLike {
  chain: string;
  tokenAddress: string | null;
  name: string;
  symbol: string;
  priceUsd: number | null;
}

function read(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { hidden: s.hidden ?? [], shown: s.shown ?? [] };
  } catch {
    return { hidden: [], shown: [] };
  }
}

function write(s: Store): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

function keyOf(chain: string, tokenAddress: string | null): string {
  return `${chain}:${(tokenAddress ?? "native").toLowerCase()}`;
}

/** Obvious airdrop/scam token? Conservative: needs no price AND a spam signal. */
export function isLikelySpam(t: TokenLike): boolean {
  if (t.tokenAddress === null) return false; // native gas token is never spam
  if (t.priceUsd != null && t.priceUsd > 0) return false; // has a market price
  const text = `${t.name} ${t.symbol}`.toLowerCase();
  return (
    /https?:\/\//.test(text) ||
    /[\w-]+\.(com|net|org|io|vip|xyz|fi|app|finance|club|site|online|pro|cash|gift|live|space|top|win|click|claim)\b/.test(text) ||
    /\b(claim|airdrop|reward|voucher|visit|access|redeem|bonus|free gift|giveaway|presale|nokyc|telegram|whatsapp|t\.me)\b/.test(text) ||
    /[$₮]\s?\d/.test(text)
  );
}

/** True if the token should be hidden from the main list. */
export function isEffectivelyHidden(t: TokenLike): boolean {
  const k = keyOf(t.chain, t.tokenAddress);
  const s = read();
  if (s.hidden.includes(k)) return true;
  if (isLikelySpam(t) && !s.shown.includes(k)) return true;
  return false;
}

export function hideToken(chain: string, tokenAddress: string | null): void {
  const s = read();
  const k = keyOf(chain, tokenAddress);
  if (!s.hidden.includes(k)) s.hidden.push(k);
  s.shown = s.shown.filter((x) => x !== k);
  write(s);
}

export function unhideToken(chain: string, tokenAddress: string | null): void {
  const s = read();
  const k = keyOf(chain, tokenAddress);
  s.hidden = s.hidden.filter((x) => x !== k);
  if (!s.shown.includes(k)) s.shown.push(k); // override the spam heuristic
  write(s);
}
