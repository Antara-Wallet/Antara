import type { Request, RequestHandler } from 'express';
import { rateLimitClient } from './clientIp.js';

export type RateLimitBuckets = Map<string, { start: number; count: number }>;
export interface RateLimitOptions { max: number | ((req: Request) => number); message: string; scope?: (req: Request) => string; windowMs?: number; maxKeys?: number; store?: RateLimitBuckets }

/** Fixed-window in-memory limiter keyed by the authenticated Privy user, falling
 * back to the client IP (clientIp.ts: the edge header on Render, otherwise req.ip
 * behind TRUST_PROXY hops; IPv6 by its /64). Each limiter owns its buckets. Buckets are
 * kept in window-start order, so once more than maxKeys exist, expired buckets
 * and then the oldest are dropped: memory stays bounded even when one window
 * sees unlimited distinct keys (for example rotated IPv6 addresses). */
export function rateLimit({ max, message, scope, windowMs = 60_000, maxKeys = 10_000, store: buckets = new Map() }: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    const key = `${req.solaresUser?.id ?? rateLimitClient(req)}:${scope?.(req) ?? ''}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; buckets.delete(key); buckets.set(key, bucket); }
    bucket.count += 1;
    if (buckets.size > maxKeys) for (const [id, entry] of buckets) { if (buckets.size <= maxKeys && now - entry.start <= windowMs) break; buckets.delete(id); }
    if (bucket.count > (typeof max === 'function' ? max(req) : max)) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).json({ error: message, code: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}
