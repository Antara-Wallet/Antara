/**
 * The client address that per-IP rate limits and the Wi-Fi (trusted network)
 * layer key on. Exactly one source is used per process:
 *
 * - Edge header (Render): Render puts Cloudflare in front of every public web
 *   service. Cloudflare sets CF-Connecting-IP to the connecting client on every
 *   request, and a request that already carries one is refused at the edge
 *   (403, "error code: 1000", measured against antara.tech). X-Forwarded-For is
 *   NOT usable there: the edge appends to whatever the client sent, and Render
 *   adds its own hops, so the client is a variable distance from the right.
 * - Proxy hops (TRUST_PROXY=n): req.ip, Express's count of trusted hops.
 * - Socket (TRUST_PROXY=false): the TCP peer address.
 *
 * A header that a client can set and the platform does not overwrite is never
 * read. When the edge header is configured but absent or malformed (a request
 * that did not come through the edge, such as Render's private network), the
 * TCP peer is used, never X-Forwarded-For.
 */
import type { Request } from 'express';
import { formatIp, parseIp } from './layers/network.js';

/**
 * Headers an edge sets itself on every request, replacing or refusing any client copy. The only ones ever trusted.
 * True-Client-IP is not one: on Render a client's own True-Client-IP reaches the app unchanged (measured 2026-10-13),
 * so trusting it would let any caller choose its address for rate limits and the Wi-Fi layer.
 */
export const EDGE_CLIENT_IP_HEADERS = ['cf-connecting-ip'] as const;
export type EdgeClientIpHeader = typeof EDGE_CLIENT_IP_HEADERS[number];
/** Express app setting carrying the configured edge header (or null). Set once in index.ts. */
export const CLIENT_IP_HEADER_SETTING = 'antara client ip header';

const isEdgeHeader = (value: unknown): value is EdgeClientIpHeader => (EDGE_CLIENT_IP_HEADERS as readonly unknown[]).includes(value);

/**
 * CLIENT_IP_HEADER: "cf-connecting-ip" or "none". Unset means
 * cf-connecting-ip on a Render web service (Render sets RENDER=true and
 * RENDER_SERVICE_TYPE=web) and none elsewhere. Client-settable headers such as
 * X-Forwarded-For, X-Real-IP, Forwarded or True-Client-IP are rejected.
 */
export function parseClientIpHeader(value: string | undefined, env: { RENDER?: string; RENDER_SERVICE_TYPE?: string }): EdgeClientIpHeader | null {
  const setting = (value ?? '').trim().toLowerCase();
  if (!setting) return env.RENDER === 'true' && (env.RENDER_SERVICE_TYPE || 'web') === 'web' ? 'cf-connecting-ip' : null;
  if (setting === 'none' || setting === 'false') return null;
  if (isEdgeHeader(setting)) return setting;
  throw new Error(`CLIENT_IP_HEADER must be ${EDGE_CLIENT_IP_HEADERS.join(', ')} or "none". Headers a client can set, such as X-Forwarded-For or True-Client-IP, are not supported.`);
}

/** Canonical single address, or undefined for anything else (lists, duplicates, ports, zone ids). */
function canonical(value: unknown): string | undefined {
  const ip = typeof value === 'string' ? parseIp(value.trim()) : null;
  return ip ? formatIp(ip) : undefined;
}

/** The client address for this request under the app's configured strategy; undefined only when nothing is observable. */
export function clientIp(req: Request): string | undefined {
  const header: unknown = typeof req.app?.get === 'function' ? req.app.get(CLIENT_IP_HEADER_SETTING) : null;
  if (!isEdgeHeader(header)) return req.ip;
  return canonical(req.headers[header]) ?? canonical(req.socket?.remoteAddress);
}

/**
 * The key per-IP rate limits count under: an IPv4 address as is, an IPv6 address by its /64 (one subscriber's
 * usual allocation), so rotating addresses inside one's own /64 does not open new buckets.
 */
export function rateLimitClient(req: Request): string | undefined {
  const address = clientIp(req);
  const ip = typeof address === 'string' ? parseIp(address) : null;
  if (!ip) return address;
  if (ip.family === 4) return formatIp(ip);
  const bytes = ip.bytes.slice();
  bytes.fill(0, 8);
  return `${formatIp({ family: 6, bytes })}/64`;
}

/** One startup log line naming the strategy. Carries no request data. */
export function describeClientIpStrategy(header: EdgeClientIpHeader | null, trustProxy: number | false, explicit: boolean) {
  const strategy = header
    ? { strategy: 'edge-header', header, source: explicit ? 'CLIENT_IP_HEADER' : 'render-default', fallback: 'socket' }
    : trustProxy === false ? { strategy: 'socket' } : { strategy: 'proxy-hops', hops: trustProxy };
  return { event: 'antara.client-ip', ...strategy };
}
