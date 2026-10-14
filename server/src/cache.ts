type Entry<T> = { value: T; expires: number };

export interface TtlCacheOptions {
  /** Upper bound on stored entries; the oldest insertion is evicted first. */
  maxEntries?: number;
  /** Expired entries are swept on writes at most once per interval. */
  sweepIntervalMs?: number;
  now?: () => number;
}

/**
 * TTL cache with in-flight de-duplication: concurrent calls for the same key
 * share one upstream request. This is the core cost-saver — many users asking
 * for the same address/price hit the provider once.
 *
 * Public routes key entries by caller-supplied addresses and ids, so the store
 * is bounded: expired entries are swept periodically, and at capacity the
 * oldest insertion is evicted. In-flight requests are never evicted.
 */
export class TtlCache {
  private store = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private nextSweep: number;

  constructor(options: TtlCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 2_000));
    this.sweepIntervalMs = Math.max(0, options.sweepIntervalMs ?? 30_000);
    this.now = options.now ?? (() => Date.now());
    this.nextSweep = this.now() + this.sweepIntervalMs;
  }

  get size(): number {
    return this.store.size;
  }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.store.get(key) as Entry<T> | undefined;
    if (hit && hit.expires > now) return hit.value;
    if (hit) this.store.delete(key);

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop every expired entry. */
  sweep(now = this.now()): void {
    for (const [key, entry] of this.store) if (entry.expires <= now) this.store.delete(key);
    this.nextSweep = now + this.sweepIntervalMs;
  }

  private set(key: string, value: unknown, ttlMs: number): void {
    const now = this.now();
    if (now >= this.nextSweep) this.sweep(now);
    // Re-inserting moves a refreshed key to the newest position.
    this.store.delete(key);
    while (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string);
    this.store.set(key, { value, expires: now + ttlMs });
  }
}

export const cache = new TtlCache();
