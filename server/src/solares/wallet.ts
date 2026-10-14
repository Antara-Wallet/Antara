import { Router, type RequestHandler } from 'express';
import { PrivyClient } from '@privy-io/node';
import { isAddress } from 'viem';
import { isSolanaAddress } from '../../../src/solares/paired/solanaDecode';
import { readWalletBalances } from './balances';
import { rateLimit } from './rateLimit';
import { pricesRouter } from './prices';
import { NETWORK_KEYS, PRIMARY_NETWORK, SOLANA_NETWORK, SUPPORTED_NETWORKS, byKey } from '../../../src/solares/networks';
import { serverRpcConfigured, solanaCluster } from '../config.js';

/** A wallet linked to the caller's Privy account, read fresh from Privy on every request. */
export interface SolaresWallet {
  address: string;
  chainType: 'ethereum' | 'solana';
  /** Privy embedded wallet (created by Privy for this account), as opposed to a linked external wallet. */
  embedded: boolean;
}
/**
 * `sessionId` is the verified token's Privy session id (`verifyAccessToken().session_id`).
 * Vault-layer challenges are bound to it; layer routes fail closed (503) when it is absent.
 */
export interface SolaresUser { id: string; sessionId?: string; wallets: SolaresWallet[] }
declare global { namespace Express { interface Request { solaresUser?: SolaresUser } } }
let privyClient: PrivyClient | null = null;
function getPrivy() {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error('Privy server authentication is not configured.');
  return privyClient ??= new PrivyClient({ appId, appSecret });
}
export const requirePrivyUser: RequestHandler = async (req, res, next) => {
  if (!process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
    res.status(503).json({ error: 'Configure PRIVY_APP_ID and PRIVY_APP_SECRET on the API server.' }); return;
  }
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
  if (!match || match[1].length > 16_384) { res.status(401).json({ error: 'A valid Privy session is required.' }); return; }
  const client = getPrivy();
  let userId: string;
  let sessionId: string | undefined;
  try {
    const verified = await client.utils().auth().verifyAccessToken(match[1]);
    userId = verified.user_id;
    // Only a well-formed session id is recorded; anything else leaves layer routes closed.
    sessionId = typeof verified.session_id === 'string' && verified.session_id.length > 0 && verified.session_id.length <= 200 ? verified.session_id : undefined;
  }
  catch { res.status(401).json({ error: 'Your session could not be verified. Sign in again.' }); return; }
  try {
    // Query fresh linked identities: a caller cannot substitute an arbitrary wallet.
    const user = await client.users()._get(userId);
    req.solaresUser = { id: user.id, ...(sessionId ? { sessionId } : {}), wallets: linkedWallets(user) };
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch { res.status(503).json({ error: 'Linked-wallet verification is temporarily unavailable. Retry shortly.' }); }
};
type PrivyUserRecord = Awaited<ReturnType<ReturnType<PrivyClient['users']>['_get']>>;
/** The Ethereum and Solana wallets linked to a Privy user record. */
function linkedWallets(user: PrivyUserRecord): SolaresWallet[] {
  return user.linked_accounts.flatMap(account => {
    if (account.type !== 'wallet' || (account.chain_type !== 'ethereum' && account.chain_type !== 'solana')) return [];
    const facts = account as { connector_type?: unknown; wallet_client_type?: unknown };
    return [{
      address: account.address,
      chainType: account.chain_type,
      embedded: facts.connector_type === 'embedded' && facts.wallet_client_type === 'privy',
    }];
  });
}

/**
 * Stable refusal for a wallet that is not linked to the token's account. Clients key on `code`
 * (src/solares/wallet/linkRecovery.ts): they ask again while a just-created wallet propagates, and
 * ask the person to sign in again when this tab's token belongs to another account.
 */
export const WALLET_NOT_LINKED = 'wallet_not_linked';
export const WALLET_NOT_LINKED_MESSAGE = 'This wallet is not linked to the ANTARA account you are signed in with. If you switched accounts, sign in again.';
export type LinkedChain = SolaresWallet['chainType'];
/** Pause before the single re-read: a wallet Privy created a moment ago may not be in the first read yet. */
export const LINK_REREAD_DELAY_MS = 500;
/** At most one re-read per account in this window, so refusals cannot be used to multiply Privy reads. */
export const LINK_REREAD_WINDOW_MS = 10_000;
const REREAD_GATE_LIMIT = 10_000;
/** True when `userId` may have a re-read now; records it. A small in-memory map, pruned as it grows. */
export type RereadGate = (userId: string, now?: number) => boolean;
export function createRereadGate(windowMs = LINK_REREAD_WINDOW_MS): RereadGate {
  const last = new Map<string, number>();
  return (userId, now = Date.now()) => {
    const previous = last.get(userId);
    if (previous !== undefined && now - previous < windowMs) return false;
    if (last.size >= REREAD_GATE_LIMIT) for (const [id, at] of last) if (now - at >= windowMs) last.delete(id);
    // Still full of recent entries: refuse the extra read rather than grow without bound (the refusal stands).
    if (last.size >= REREAD_GATE_LIMIT && !last.has(userId)) return false;
    last.set(userId, now);
    return true;
  };
}
const defaultRereadGate = createRereadGate();
/** A well-formed address for its chain: only such an address can be a wallet Privy has not listed yet. */
function wellFormed(address: string, chainType: LinkedChain): boolean {
  return chainType === 'ethereum' ? isAddress(address, { strict: false }) : isSolanaAddress(address);
}
/**
 * The first requested chain whose address is not linked to the caller, or null when all are.
 * Before refusing, the caller's Privy user is read once more (after `delayMs`): Privy creates
 * embedded wallets on the client right after login, and the first read can precede them. That is
 * the only race this covers, so the re-read happens only when every unlisted address is well formed
 * and the first read has no embedded wallet on its chain yet, and at most once per account every
 * LINK_REREAD_WINDOW_MS. It must return the same user and only ever replaces the wallet list with
 * Privy's fresh answer; a skipped or failed re-read keeps the refusal (fail closed).
 */
export async function unlinkedChain(
  req: { solaresUser?: SolaresUser },
  requested: ReadonlyArray<{ address: string; chainType: LinkedChain }>,
  options: { delayMs?: number; loadUser?: (id: string) => Promise<PrivyUserRecord>; rereadGate?: RereadGate } = {},
): Promise<LinkedChain | null> {
  const unlisted = () => requested.filter(item => item.address && !isOwnedAddress(req.solaresUser, item.address, item.chainType));
  const missing = () => unlisted()[0]?.chainType ?? null;
  const first = missing();
  const user = req.solaresUser;
  if (!first || !user?.id) return first;
  const lagging = unlisted().every(item => wellFormed(item.address, item.chainType) && !user.wallets.some(wallet => wallet.chainType === item.chainType && wallet.embedded));
  if (!lagging || !(options.rereadGate ?? defaultRereadGate)(user.id)) return first;
  try {
    const delayMs = options.delayMs ?? LINK_REREAD_DELAY_MS;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const fresh = await (options.loadUser ?? (id => getPrivy().users()._get(id)))(user.id);
    if (fresh?.id !== user.id || !Array.isArray(fresh.linked_accounts)) return first;
    req.solaresUser = { ...user, wallets: linkedWallets(fresh) };
  } catch { return first; }
  const still = missing();
  // Operator evidence for how often Privy's first read lags a just-created wallet. No user id or address is logged.
  if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify({ event: 'antara.wallet-link', at: new Date().toISOString(), outcome: still ? 'refused' : 'late', chain: still ?? first }));
  return still;
}
export function ownedWallet(user: SolaresUser | undefined, address: string, chainType: 'ethereum' | 'solana'): SolaresWallet | undefined {
  return user?.wallets.find(wallet => wallet.chainType === chainType && (chainType === 'ethereum'
    ? wallet.address.toLowerCase() === address.toLowerCase() : wallet.address === address));
}
export function isOwnedAddress(user: SolaresUser | undefined, address: string, chainType: 'ethereum' | 'solana') {
  return !!ownedWallet(user, address, chainType);
}
// requirePrivyUser calls the Privy API on every request, so a coarse per-IP limit
// runs before it; per-account limits still run after it. Each router owns one.
export const limitBeforeAuth = () => rateLimit({ max: 120, scope: () => 'pre-auth', message: 'Too many requests. Please wait a minute and try again.' });
export const walletRouter = Router();
// Public readiness: pinned registry facts and booleans only, never an RPC URL.
// rpcConfigured=false means no valid dedicated RPC: the network uses its
// rate-limited official public RPC, or a malformed override makes its reads fail.
walletRouter.get('/config', (_req, res) => {
  res.json({
    configured: !!process.env.PRIVY_APP_ID && !!process.env.PRIVY_APP_SECRET,
    primaryChain: PRIMARY_NETWORK,
    chains: NETWORK_KEYS,
    networks: SUPPORTED_NETWORKS.map(network => ({
      key: network.key, name: network.name, vm: network.vm, relayChainId: network.relay.chainId, evmChainId: network.evmChainId,
      rpcConfigured: serverRpcConfigured(network),
      native: { symbol: network.native.symbol, decimals: network.native.decimals },
      funding: {
        symbol: network.funding.symbol, label: network.funding.label, name: network.funding.name, address: network.funding.address,
        decimals: network.funding.decimals, issuer: network.funding.issuer, circleIssued: network.funding.circleIssued,
      },
    })),
    solanaCluster: solanaCluster(),
    // Earlier clients read these two flags.
    ethereumRpcConfigured: serverRpcConfigured(byKey('ethereum')),
    solanaRpcConfigured: serverRpcConfigured(SOLANA_NETWORK),
  });
});
// Public market data: USD prices for each network's native coin and funding stablecoin, from Relay
// (prices.ts). No session or wallet is involved, so it is served before authentication, limited per IP.
walletRouter.use('/prices', pricesRouter());
walletRouter.use(limitBeforeAuth(), requirePrivyUser);
// One request fans out to every network RPC, so each account is rate limited.
const balanceLimit = rateLimit({ max: 30, scope: () => 'balances', message: 'Please wait before refreshing balances again.' });
walletRouter.get('/balances', balanceLimit, async (req, res) => {
  const solanaAddress = typeof req.query.solana === 'string' ? req.query.solana : '';
  const evmAddress = typeof req.query.ethereum === 'string' ? req.query.ethereum : '';
  const unlinked = await unlinkedChain(req, [{ address: solanaAddress, chainType: 'solana' }, { address: evmAddress, chainType: 'ethereum' }]);
  if (unlinked) { res.status(403).json({ error: WALLET_NOT_LINKED_MESSAGE, code: WALLET_NOT_LINKED, chain: unlinked }); return; }
  const { balances, failures } = await readWalletBalances(evmAddress, solanaAddress);
  res.json({ balances, failures, observedAt: new Date().toISOString(), solanaCluster: solanaCluster() });
});
