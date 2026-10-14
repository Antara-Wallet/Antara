/**
 * The wallet's USD prices (prices.ts), shared by every screen that values a balance: the wallet
 * total, token rows and detail, and the vault cards. One store per page: the first subscriber
 * reads GET /api/solares/wallet/prices, then every minute while anything is subscribed and the
 * window is visible; the last unsubscribe aborts the read in flight and stops the timer.
 *
 * A failed refresh keeps the previous snapshot while it is under ten minutes old (it carries its
 * own time, which the screens show); older, or with none, prices are unavailable and screens fall
 * back to token amounts. Nothing here is ever a guessed price.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { API_URL } from './config';
import { parsePriceSnapshot, type PricesState } from './prices';

export const PRICES_PATH = '/api/solares/wallet/prices';
export const PRICE_REFRESH_MS = 60_000;
export const PRICE_REQUEST_TIMEOUT_MS = 10_000;
/** A snapshot older than this is not shown after a failed refresh. */
export const PRICE_STALE_MS = 10 * 60_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;
export interface PriceStoreOptions {
  url?: string;
  fetch?: FetchLike;
  now?: () => number;
  refreshMs?: number;
  timeoutMs?: number;
  /** Whether the page is hidden; a hidden page skips refreshes and catches up when shown. */
  hidden?: () => boolean;
}
export interface PriceStore {
  getState: () => PricesState;
  subscribe: (listener: () => void) => () => void;
}

const LOADING: PricesState = Object.freeze({ status: 'loading' });
const UNAVAILABLE: PricesState = Object.freeze({ status: 'unavailable' });

export function createPriceStore(options: PriceStoreOptions = {}): PriceStore {
  const url = options.url ?? `${API_URL}${PRICES_PATH}`;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? PRICE_REFRESH_MS;
  const timeoutMs = options.timeoutMs ?? PRICE_REQUEST_TIMEOUT_MS;
  const hidden = options.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  let state: PricesState = LOADING;
  let lastRead = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingForVisible = false;
  const listeners = new Set<() => void>();
  const publish = (next: PricesState) => { state = next; for (const listener of [...listeners]) listener(); };
  const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(() => { void load(); }, delay); };

  async function load() {
    if (!listeners.size) return;
    if (hidden()) { waitingForVisible = true; return; }
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const deadline = setTimeout(() => current.abort(), timeoutMs);
    lastRead = now();
    try {
      const response = await fetchImpl(url, { signal: current.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('Prices unavailable.');
      const snapshot = parsePriceSnapshot(await response.json());
      if (current.signal.aborted) return;
      publish({ status: 'ready', snapshot });
    } catch {
      if (controller !== current || !listeners.size) return;
      const keep = state.status === 'ready' && now() - Date.parse(state.snapshot.observedAt) < PRICE_STALE_MS;
      if (!keep) publish(UNAVAILABLE);
    } finally {
      clearTimeout(deadline);
      if (controller === current) {
        controller = null;
        if (listeners.size) schedule(refreshMs);
      }
    }
  }

  const onVisible = () => {
    if (!waitingForVisible || hidden()) return;
    waitingForVisible = false;
    void load();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
        // A recent snapshot is reused; otherwise read now.
        if (state.status === 'loading' || now() - lastRead >= refreshMs) void load();
        else schedule(refreshMs - (now() - lastRead));
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        clearTimeout(timer);
        controller?.abort();
        controller = null;
        waitingForVisible = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}

let shared: PriceStore | null = null;
const sharedStore = () => (shared ??= createPriceStore());
const idle = () => () => {};

/**
 * The current prices. `enabled` false (signed out, nothing to value) neither reads nor subscribes,
 * and reports whatever the store last knew.
 */
export function usePrices(enabled = true): PricesState {
  const store = sharedStore();
  const subscribe = useCallback((listener: () => void) => enabled ? store.subscribe(listener) : idle(), [enabled, store]);
  return useSyncExternalStore(subscribe, store.getState, store.getState);
}
