/**
 * What the client does when the API server does not see the selected wallet as linked to the
 * signed-in account (owner screenshot of antara.tech/app, 2026-10-14: "The requested wallet is
 * not linked to this session." with the vault card asking for the ANTARA wallet it already had).
 *
 * Two causes, both read from the installed @privy-io/react-auth 3.48 source:
 *
 * 1. Session changed elsewhere. Privy keeps the access token in localStorage (`privy:token`,
 *    shared by every tab and window of the origin) and getAccessToken() reads it on every call
 *    without comparing it to the tab's `user`. Each tab keeps its own `user` state; nothing syncs
 *    it when another tab signs in a different account. That tab then shows one account's wallets
 *    while sending the other account's token, and every wallet check fails for good. This is
 *    detected by comparing the token's subject with the signed-in user and is never retried: the
 *    person signs in again.
 * 2. A wallet Privy created a moment ago (embeddedWallets.createOnLogin) is already in this
 *    client's user while the server's Privy read does not list it yet. That is asked again with a
 *    short backoff.
 *
 * The server's ownership check is never relaxed here: these only decide when to ask again and
 * what to say.
 */

/** The API server's code for a wallet that is not linked to the token's account (server/src/solares/wallet.ts). */
export const WALLET_NOT_LINKED = 'wallet_not_linked';
/** What a server released before the code existed answered for the same refusal. */
const LEGACY_NOT_LINKED = 'The requested wallet is not linked to this session.';
/** Waits before asking again while a just-linked wallet propagates: about 15 s in all. */
export const LINK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_500, 4_000, 10_000]);

export const SESSION_CHANGED_MESSAGE = 'Your session changed in another tab or window. Sign in again to continue.';
export const WALLET_NOT_CONFIRMED_MESSAGE = 'ANTARA could not confirm this wallet belongs to the account you are signed in with. Retry in a moment, or sign in again.';
export const unlinkedSelectionMessage = (chain: LinkedChain) =>
  `Your selected ${chain === 'solana' ? 'Solana' : 'EVM'} wallet is connected here but not linked to your ANTARA account, so its balances are not shown.`;

export type LinkedChain = 'solana' | 'ethereum';
export interface LinkedWallet { chain: LinkedChain; address: string }

/** This tab's token belongs to another account than the one it shows. */
export class SessionChangedError extends Error {
  readonly code = 'session_changed';
  constructor() { super(SESSION_CHANGED_MESSAGE); this.name = 'SessionChangedError'; }
}
/** The server refused a wallet as not linked to the token's account. */
export class WalletNotLinkedError extends Error {
  readonly code = WALLET_NOT_LINKED;
  constructor(message: string, readonly chain: LinkedChain | null) { super(message); this.name = 'WalletNotLinkedError'; }
}

/**
 * The `sub` claim of an access token, or null when it cannot be read. Nothing is verified here:
 * the server verifies every token. This only notices a token minted for another account.
 */
export function accessTokenSubject(token: string): string | null {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const payload = parts.length === 3 ? parts[1] : '';
  if (!payload || payload.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const claims: unknown = JSON.parse(atob(base64));
    const subject = claims && typeof claims === 'object' ? (claims as { sub?: unknown }).sub : undefined;
    return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 ? subject : null;
  } catch { return null; }
}

/** Throws SessionChangedError when `token` was minted for another account than `userId` (the account this tab shows). */
export function assertTokenForUser(token: string | null, userId: string | null): void {
  if (!token || !userId) return;
  const subject = accessTokenSubject(token);
  if (subject !== null && subject !== userId) throw new SessionChangedError();
}

/** The server's not-linked refusal as an error, or null for any other answer. */
export function walletNotLinked(status: number, body: unknown): WalletNotLinkedError | null {
  if (status !== 403 || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { code, chain, error } = body as Record<string, unknown>;
  if (code !== WALLET_NOT_LINKED && error !== LEGACY_NOT_LINKED) return null;
  const message = typeof error === 'string' && error.length > 0 && error.length <= 300 && error !== LEGACY_NOT_LINKED ? error : WALLET_NOT_CONFIRMED_MESSAGE;
  return new WalletNotLinkedError(message, chain === 'solana' || chain === 'ethereum' ? chain : null);
}

/** Same address on the same chain: EVM addresses compare without case, Solana addresses exactly. */
export function sameLinkedWallet(a: LinkedWallet, b: LinkedWallet): boolean {
  return a.chain === b.chain && (a.chain === 'ethereum' ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address);
}
/** True when this client's Privy user lists `address` on `chain` as a linked wallet. */
export function isLinkedHere(linked: readonly LinkedWallet[] | undefined, chain: LinkedChain, address: string | null | undefined): boolean {
  return !!address && !!linked?.some(item => sameLinkedWallet(item, { chain, address }));
}

/** The wallet accounts on a Privy user (react-auth `user.linkedAccounts`), in a stable order. */
export function linkedWalletsOf(accounts: ReadonlyArray<unknown> | null | undefined): LinkedWallet[] {
  const wallets = (accounts ?? []).flatMap((account): LinkedWallet[] => {
    const item = account as { type?: unknown; chainType?: unknown; address?: unknown } | null;
    if (item?.type !== 'wallet' || typeof item.address !== 'string' || !item.address) return [];
    return item.chainType === 'solana' || item.chainType === 'ethereum' ? [{ chain: item.chainType, address: item.address }] : [];
  });
  return wallets.sort((a, b) => `${a.chain}:${a.address}`.localeCompare(`${b.chain}:${b.address}`));
}
/** Changes exactly when the set of linked wallets changes, so reads keyed on it re-run then and only then. */
export const linkedWalletsKey = (wallets: readonly LinkedWallet[]) =>
  wallets.map(item => `${item.chain}:${item.chain === 'ethereum' ? item.address.toLowerCase() : item.address}`).join(',');

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
export interface LinkRetryOptions<T> {
  /** True when this outcome means "not linked yet" and asking again may help. Anything else is final. */
  retryable: (outcome: Outcome<T>) => boolean;
  delays?: readonly number[];
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, ms);
    function stop() { clearTimeout(timer); reject(signal!.reason); }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Runs `run`, and while its outcome is `retryable`, waits and runs it again: once per entry in
 * `delays` (1.5 s, 4 s, 10 s by default), then returns or throws the last outcome as it is.
 * Stops at once when `signal` aborts. `run` receives the attempt number (0 first).
 */
export async function retryUntilLinked<T>(run: (attempt: number) => Promise<T>, options: LinkRetryOptions<T>): Promise<T> {
  const delays = options.delays ?? LINK_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let outcome: Outcome<T>;
    try { outcome = { ok: true, value: await run(attempt) }; }
    catch (error) { outcome = { ok: false, error }; }
    if (attempt >= delays.length || options.signal?.aborted || !options.retryable(outcome)) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
    await sleep(delays[attempt], options.signal);
  }
}
