import { pinnedTokens, sameAddress, tradeNetwork, type TradeToken } from './model';
import { validAddress, validateTradeToken } from './validation';

/** Currency metadata is untrusted. Do not pass provider extras, other chains or stablecoin lookalikes to the picker. */
export function parseCurrencies(input: unknown, chainId: number): TradeToken[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Token search returned an invalid response.');
  const network = tradeNetwork(chainId);
  const tokens: TradeToken[] = [];
  for (const entry of input) {
    try {
      if (!entry || typeof entry !== 'object') continue;
      const { address, symbol, name, decimals, chainId: receivedChain } = entry;
      const token = validateTradeToken({ chainId: receivedChain, address, symbol, name, decimals }, chainId);
      if (!tokens.some(other => sameAddress(other.address, token.address, network.vm))) tokens.push(token);
    } catch { /* Ignore malformed or unsupported metadata; never invent decimals. */ }
  }
  return tokens;
}

export function currencySearchRequest(chainId: number, term: string): Record<string, unknown> {
  const network = tradeNetwork(chainId);
  if (term.length > 100 || /[\p{C}]/u.test(term)) throw new Error('Search by a token name, symbol, or contract address.');
  const query = term.trim();
  const isAddress = validAddress(query, network.vm) || sameAddress(query, network.native, network.vm);
  return { chainIds: [chainId], limit: 50, ...(query
    ? { ...(isAddress ? { address: query } : { term: query }), useExternalSearch: true }
    : { defaultList: true, verified: true }) };
}

/** The network's native token and its pinned funding stablecoin (USDC, Binance-Peg USDC or USDG). */
export function initialCurrencies(chainId: number): TradeToken[] {
  return pinnedTokens(tradeNetwork(chainId));
}

/**
 * The registry entry when `address` is the network's native coin or funding stablecoin. Provider
 * metadata never decides these: with external search on, Relay names Robinhood Chain's ETH "WETH".
 */
export function pinnedCurrency(chainId: number, address: string): TradeToken | undefined {
  const network = tradeNetwork(chainId);
  return pinnedTokens(network).find(token => sameAddress(token.address, address, network.vm));
}

/**
 * Relay's own currency list and external search disagree on letter case for the same contract
 * ("nvda" and "NVDA" on Robinhood Chain, "BONK" and "Bonk" on Solana). Tickers are display text;
 * chain, address and decimals stay exact.
 */
export function sameTokenSymbol(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Re-verification lookups for a selected token: Relay's own list first, then external search. */
export function tokenLookupRequests(token: Pick<TradeToken, 'chainId' | 'address'>): Record<string, unknown>[] {
  return [false, true].map(useExternalSearch => ({ chainIds: [token.chainId], address: token.address, useExternalSearch, limit: 10 }));
}
