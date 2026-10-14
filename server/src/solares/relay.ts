import { Router, type Request, type Response } from 'express';
// The pinned SDK publishes this module. Avoid importing unrelated protocol
// transaction builders (Anchor, withdrawal adapters) into API startup.
import { getOrderId } from '@relay-protocol/settlement-sdk/dist/order/index.js';
import { requirePrivyUser, isOwnedAddress, limitBeforeAuth } from './wallet';
import {
  MAX_FUNDING_UNITS, RELAY_EVM_FILL_CONTRACT, RELAY_NETWORKS, RELAY_SOLVER, sameAddress, tokenFor, tradeNetwork,
  type RelayQuote, type ReviewedQuote, type TradeIntent, type TradeNetwork, type TradeToken,
} from '../../../src/solares/relay/model';
import { validateIntent, validateQuote, normalizeQuoteApprovals, quoteRequestId, verifyReviewedQuote } from '../../../src/solares/relay/validation';
import { currencySearchRequest, parseCurrencies, pinnedCurrency, sameTokenSymbol, tokenLookupRequests } from '../../../src/solares/relay/currencies';
import { RELAY_SOLANA_DEPOSITORY_VAULT } from '../../../src/solares/networks';
import { rateLimit } from './rateLimit';

const router = Router();
const RELAY_ORIGIN = 'https://api.relay.link';
const REQUEST_ID = /^0x[\da-f]{64}$/i;
// Relay protocol slug -> settlement VM for every supported network (BNB Smart Chain is 'bnb' at Relay).
const SETTLEMENT_VMS = Object.fromEntries(RELAY_NETWORKS.map((chain) => [chain.protocol, chain.vmType]));
export function verifySettlementIntegrity(quote: RelayQuote) {
  const computed = getOrderId(quote.protocol.v2.orderData, SETTLEMENT_VMS);
  if (computed.toLowerCase() !== quote.protocol.v2.orderId.toLowerCase()) throw new Error('Relay settlement order failed integrity verification.');
}
const limit = rateLimit({ scope: req => req.method === 'POST' ? 'quote' : 'read', max: req => req.method === 'POST' ? 12 : 90, message: 'Please wait before requesting another route.' });

type ChainMetadata = {
  id: number; vmType?: string;
  protocol?: { v2?: { chainId?: string; depository?: string; depositoryVault?: string } };
  contracts?: { erc20Router?: string };
  solverAddresses?: string[];
};
let chainsCache: { expires: number; chains: ChainMetadata[] } | undefined;
async function upstream(path: string, body?: unknown, publicMetadata = false): Promise<unknown> {
  const key = process.env.RELAY_API_KEY;
  if (!key && !publicMetadata) throw new Error('Relay is not configured. Add RELAY_API_KEY on the server.');
  // This helper is reachable only with fixed internal paths. No client URL,
  // redirect, arbitrary method, or client-supplied header is forwarded.
  const response = await fetch(`${RELAY_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(key ? { 'x-api-key': key } : {}), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Relay credentials are not accepted. Check the server API key.');
    if (response.status === 429) throw new Error('Relay is busy. Wait a moment before requesting a new quote.');
    if (response.status >= 500) throw new Error('Relay is temporarily unavailable. Your wallet has not submitted a trade.');
    throw new Error('Relay could not quote this route. Try a different amount or destination.');
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('Relay returned an unexpectedly large response.');
  return JSON.parse(text);
}
/**
 * Keep only supported chain ids (never a same-named venue such as "Robinhood
 * Lighter") and require each one's protocol slug and depository to match the
 * independently pinned registry values. Solana must also publish the pinned
 * depository vault account, every EVM network the pinned fill contract
 * (erc20Router), and Base the pinned solver. Any drift, or a missing value, fails closed.
 */
export function verifiedChainMetadata(input: unknown): ChainMetadata[] {
  if (!Array.isArray(input)) throw new Error('Relay chain metadata is unavailable.');
  const chains = input.filter((chain): chain is ChainMetadata => Boolean(chain) && typeof chain === 'object' && RELAY_NETWORKS.some((network) => network.id === (chain as ChainMetadata).id));
  for (const network of RELAY_NETWORKS) {
    const matches = chains.filter((chain) => chain.id === network.id);
    const metadata = matches[0];
    if (matches.length !== 1 || metadata?.protocol?.v2?.chainId !== network.protocol || typeof metadata.protocol.v2.depository !== 'string' || !sameAddress(metadata.protocol.v2.depository, network.depository, network.vm) ||
      (network.vm === 'solana' && metadata.protocol.v2.depositoryVault !== RELAY_SOLANA_DEPOSITORY_VAULT) ||
      (network.vm === 'ethereum' && (typeof metadata.contracts?.erc20Router !== 'string' || metadata.contracts.erc20Router.toLowerCase() !== RELAY_EVM_FILL_CONTRACT))) {
      throw new Error('Relay contracts changed. Route validation must be reviewed before trading.');
    }
  }
  const solverChain = chains.find((chain) => chain.protocol?.v2?.chainId === RELAY_SOLVER.chain);
  if (!solverChain || !Array.isArray(solverChain.solverAddresses) || !solverChain.solverAddresses.some((address) => typeof address === 'string' && address.toLowerCase() === RELAY_SOLVER.address)) {
    throw new Error('Relay contracts changed. Route validation must be reviewed before trading.');
  }
  return chains;
}
async function chainMetadata() {
  if (chainsCache && chainsCache.expires > Date.now()) return chainsCache.chains;
  const data = await upstream('/chains') as { chains?: unknown };
  const chains = verifiedChainMetadata(data?.chains);
  chainsCache = { expires: Date.now() + 300_000, chains };
  return chains;
}
router.get('/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Each network funds swaps from its own pinned stablecoin (USDC, Binance-Peg USDC or USDG). Owner decision
  // 2026-10-13: no per-swap or daily swap cap. The only bound is the protocol sanity ceiling of MAX_FUNDING_UNITS
  // whole units per swap that every order validator already enforces. Relay orders can stay open for up to 7 days
  // and do not guarantee a refund amount; the client discloses both before every swap.
  const ceiling = MAX_FUNDING_UNITS.toString();
  res.json({
    configured: Boolean(process.env.RELAY_API_KEY), environment: 'mainnet', mode: 'verified-funding-origin',
    // maxFundingUnits is kept for older clients; both equal the protocol sanity ceiling per swap.
    maxFundingUnits: ceiling,
    maxTradeUnits: ceiling,
    // No daily swap cap.
    maxDailyUnits: null,
    fillWindowDays: 7, refundGuaranteed: false,
    swapLimitsError: null,
    networks: RELAY_NETWORKS.map(({ id, name, funding }) => ({ id, name, funding: { address: funding.address, symbol: funding.symbol, label: funding.label, decimals: funding.decimals } })),
  });
});
const currenciesCache = new Map<string, { expires: number; tokens: TradeToken[] }>();
router.get('/currencies', limit, async (req, res) => {
  try {
    if (Object.keys(req.query).some(key => !['chainId', 'term'].includes(key)) || typeof req.query.chainId !== 'string' ||
      (req.query.term !== undefined && typeof req.query.term !== 'string')) throw new Error('Invalid token search.');
    const chainId = Number(req.query.chainId);
    const term = (req.query.term as string | undefined) ?? '';
    const body = currencySearchRequest(chainId, term);
    const cacheKey = JSON.stringify(body);
    const cached = currenciesCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) { res.json({ tokens: cached.tokens }); return; }
    const tokens = parseCurrencies(await upstream('/currencies/v2', body, true), chainId);
    if (currenciesCache.size >= 200) currenciesCache.delete(currenciesCache.keys().next().value!);
    currenciesCache.set(cacheKey, { tokens, expires: Date.now() + 60_000 });
    res.json({ tokens });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Token search is unavailable.' });
  }
});

export function relayQuoteRequest(intent: TradeIntent) {
  const source = tradeNetwork(intent.originChainId), destination = tradeNetwork(intent.destinationChainId);
  return {
    user: intent.user, recipient: intent.recipient,
    originChainId: source.id, destinationChainId: destination.id,
    // The origin currency is always the source network's pinned funding stablecoin, never a client-chosen token.
    originCurrency: source.funding.address, destinationCurrency: tokenFor(destination, intent.destinationToken).address,
    amount: intent.amount, tradeType: 'EXACT_INPUT', slippageTolerance: intent.slippageBps.toString(),
    refundTo: intent.user, includeProtocolData: true, explicitDeposit: true,
    // Same-chain swaps otherwise default to arbitrary DEX calldata. Request the
    // solver path so every payout is still committed to a verifiable order.
    forceSolverExecution: true, usePermit: false, useDepositAddress: false, ttl: 120,
  };
}

const TOKEN_CHANGED = 'Token metadata changed or is unavailable. Select the token again before swapping.';
/**
 * The destination network's native coin and funding stablecoin are checked against the pinned registry
 * only (the legacy 'native'/'USDC' selectors resolve to them). Any other token is looked up in Relay's
 * own list, then (only when that list does not know the address) with external search: chain, address
 * and decimals must match exactly, the ticker ignoring letter case. The first source that knows the
 * address decides, so external search never overrules Relay's own list. A lookup failure fails closed.
 */
export async function verifyDestinationToken(intent: TradeIntent) {
  const destination = tradeNetwork(intent.destinationChainId);
  const selected = tokenFor(destination, intent.destinationToken);
  if (selected.chainId !== destination.id) throw new Error(TOKEN_CHANGED);
  const pinned = pinnedCurrency(destination.id, selected.address);
  if (pinned) {
    if (selected.decimals !== pinned.decimals || selected.symbol !== pinned.symbol) throw new Error(TOKEN_CHANGED);
    return;
  }
  for (const body of tokenLookupRequests(selected)) {
    const resolved = parseCurrencies(await upstream('/currencies/v2', body, true), destination.id)
      .find(token => sameAddress(token.address, selected.address, destination.vm));
    if (!resolved) continue;
    if (resolved.decimals !== selected.decimals || !sameTokenSymbol(resolved.symbol, selected.symbol)) throw new Error(TOKEN_CHANGED);
    return;
  }
  throw new Error(TOKEN_CHANGED);
}
router.use(limitBeforeAuth(), requirePrivyUser, limit);
router.get('/chains', async (_req, res) => {
  try { res.json({ chains: await chainMetadata() }); }
  catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Chain metadata is unavailable.' }); }
});
function rejectRoute(res: Response, error: unknown) {
  res.status(400).json({ error: error instanceof Error ? error.message : 'This route could not be verified. No transaction was sent.', code: 'ROUTE_REJECTED' });
}
router.post('/quote', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.RELAY_API_KEY) { res.status(503).json({ error: 'Add RELAY_API_KEY on the server to enable live routes.', code: 'RELAY_NOT_CONFIGURED' }); return; }
  let intent: TradeIntent, source: TradeNetwork, destination: TradeNetwork;
  try {
    intent = validateIntent(req.body);
    source = tradeNetwork(intent.originChainId);
    destination = tradeNetwork(intent.destinationChainId);
  } catch (error) { rejectRoute(res, error); return; }
  const user = req.solaresUser;
  if (!user || !isOwnedAddress(user, intent.user, source.vm) || !isOwnedAddress(user, intent.recipient, destination.vm)) {
    res.status(403).json({ error: 'Both route wallets must belong to your authenticated Privy account.' });
    return;
  }
  // Owner decision 2026-10-13: every wallet linked to the account can receive a swap as soon as it is linked (no
  // link-age wait), and there is no per-swap or daily cap beyond the protocol sanity ceiling validateIntent enforces
  // (MAX_FUNDING_UNITS whole units, in the source stablecoin's own decimals). Every order check below still applies.
  try {
    await chainMetadata();
    await verifyDestinationToken(intent);
    const quote = await upstream('/quote/v2', relayQuoteRequest(intent)) as RelayQuote;
    normalizeQuoteApprovals(quote, intent);
    validateQuote(quote, intent);
    // VM mappings are configured independently of the quote. Missing or newly
    // introduced order versions deliberately fail closed.
    verifySettlementIntegrity(quote);
    const requestId = quoteRequestId(quote);
    const quotedAt = Date.now();
    const reviewed: ReviewedQuote = { quote, intent, requestId, quotedAt, expiresAt: Math.min(quotedAt + 90_000, quote.protocol.v2.orderData.output.deadline * 1000 - 10_000) };
    // The same gate the wallet runs before signing: policy, client order hash and the pinned solver's signature.
    await verifyReviewedQuote(reviewed, intent, quotedAt);
    res.json(reviewed);
  } catch (error) {
    rejectRoute(res, error);
  }
});
async function status(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const requestId = req.params.requestId ?? req.query.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) { res.status(400).json({ error: 'Invalid route identifier.' }); return; }
  try {
    const data = await upstream(`/intents/status/v3?requestId=${requestId}`) as Record<string, unknown>;
    const knownStatuses = ['waiting', 'depositing', 'pending', 'submitted', 'delayed', 'success', 'refund', 'failure'];
    // Status APIs are public on Relay. Only non-sensitive settlement fields are
    // returned here; user identities, upstream requests, and keys are never sent.
    res.json({
      status: typeof data.status === 'string' && knownStatuses.includes(data.status) ? data.status : 'unresolved',
      inTxHashes: Array.isArray(data.inTxHashes) ? data.inTxHashes.filter((hash) => typeof hash === 'string' && /^[a-zA-Z0-9]{32,128}$/.test(hash)) : [],
      txHashes: Array.isArray(data.txHashes) ? data.txHashes.filter((hash) => typeof hash === 'string' && /^[a-zA-Z0-9]{32,128}$/.test(hash)) : [],
      originChainId: data.originChainId,
      destinationChainId: data.destinationChainId,
      updatedAt: data.updatedAt,
      failReason: typeof data.failReason === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.failReason) ? data.failReason : null,
      refundFailReason: typeof data.refundFailReason === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.refundFailReason) ? data.refundFailReason : null,
    });
  } catch {
    res.status(503).json({ error: 'Settlement status is temporarily unavailable. Do not submit the deposit again.', status: 'unresolved' });
  }
}
router.get('/status/:requestId', status);
// The SDK's checks are pinned to this exact endpoint by quote validation.
router.get('/intents/status/v3', status);
router.post('/transactions/index', async (req, res) => {
  const chainId = Number(req.body?.chainId);
  const hash = req.body?.txHash;
  const requestId = req.body?.requestId;
  const network = RELAY_NETWORKS.find((chain) => chain.id === chainId);
  if (!network || typeof hash !== 'string' || !(network.vm === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(hash) : /^0x[\da-f]{64}$/i.test(hash)) ||
    (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)))) {
    res.status(400).json({ error: 'Invalid submitted transaction.' }); return;
  }
  try { await upstream('/transactions/index', { chainId: chainId.toString(), txHash: hash }); res.json({ accepted: true }); }
  catch { res.status(503).json({ error: 'Index notification unavailable; settlement tracking will continue.' }); }
});
export default router;
