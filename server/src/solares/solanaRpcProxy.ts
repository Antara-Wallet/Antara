import { Router, type Request, type Response } from 'express';
import { rateLimit } from './rateLimit';
import { SOLANA_NETWORK } from '../../../src/solares/networks';
import { serverRpcConfigured, serverRpcUrl } from '../config.js';

/**
 * Same-origin Solana JSON-RPC for the web app, extension and desktop app.
 * Free public endpoints refuse indexed calls from browsers (publicnode answers
 * getProgramAccounts with 403), which broke vault verification. This forwards a
 * fixed set of read/send methods to the server's own RPC. The upstream URL holds
 * an API key: it is never logged, echoed or returned.
 */
export const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const ALLOWED_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getEpochInfo', 'getFeeForMessage', 'getGenesisHash', 'getHealth',
  'getLatestBlockhash', 'getMinimumBalanceForRentExemption', 'getMultipleAccounts', 'getProgramAccounts',
  'getRecentPrioritizationFees', 'getSignatureStatuses', 'getSignaturesForAddress', 'getSlot', 'getTokenAccountBalance',
  'getTokenAccountsByOwner', 'getTokenSupply', 'getTransaction', 'getVersion', 'isBlockhashValid', 'sendTransaction',
  'simulateTransaction',
]);
const MAX_BATCH = 10;
const UPSTREAM_TIMEOUT_MS = 20_000;

type RpcCall = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const validId = (id: unknown) => id === undefined || id === null || typeof id === 'number' || (typeof id === 'string' && id.length <= 128);

/** Why this call is refused, or null when it may be forwarded. */
export function refuseCall(call: RpcCall): string | null {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return 'Invalid request.';
  if (typeof call.method !== 'string' || !ALLOWED_METHODS.has(call.method)) return 'Method not available.';
  if (!validId(call.id)) return 'Invalid request id.';
  if (call.params !== undefined && !Array.isArray(call.params)) return 'Invalid params.';
  if (call.method === 'getProgramAccounts') {
    // Only filtered Squads lookups (vault spending-limit checks); never an open program scan.
    const [program, config] = (call.params ?? []) as [unknown, { filters?: unknown } | undefined];
    if (program !== SQUADS_PROGRAM_ID) return 'Program not available.';
    const filters = config && typeof config === 'object' ? config.filters : undefined;
    if (!Array.isArray(filters) || filters.length < 1 || filters.length > 4) return 'A filtered query is required.';
    if (!filters.some(filter => filter && typeof filter === 'object' && 'memcmp' in filter && (filter as { memcmp?: { offset?: unknown } }).memcmp?.offset === 8)) {
      return 'A filtered query is required.';
    }
  }
  return null;
}

async function forward(upstream: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(upstream, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await response.text();
  try { return { status: response.ok ? 200 : response.status, json: JSON.parse(text) }; }
  catch { throw new Error('upstream returned non-JSON'); }
}

export function solanaRpcRouter(options: { upstream?: () => string; configured?: () => boolean; perIpPerMinute?: number; globalPerMinute?: number } = {}) {
  const upstream = options.upstream ?? (() => serverRpcUrl(SOLANA_NETWORK));
  const configured = options.configured ?? (() => serverRpcConfigured(SOLANA_NETWORK));
  const router = Router();
  // A ceiling across every caller, so rotating addresses cannot drain the upstream quota.
  const globalMax = options.globalPerMinute ?? 20_000;
  let windowStart = 0, windowCount = 0;
  router.post('/',
    (_req, res, next) => {
      const now = Date.now();
      if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
      if (++windowCount > globalMax) { res.setHeader('Retry-After', '60'); res.status(429).json(rpcError(null, -32005, 'Solana is busy. Try again shortly.')); return; }
      next();
    },
    rateLimit({ max: options.perIpPerMinute ?? 300, scope: () => 'solana-rpc', message: 'Too many Solana requests. Wait a moment and try again.' }),
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!configured()) { res.status(503).json(rpcError(null, -32000, 'Solana is not configured on this server.')); return; }
      const body = req.body as RpcCall | RpcCall[];
      const batch = Array.isArray(body);
      const calls = batch ? body : [body];
      if (!calls.length || calls.length > MAX_BATCH) { res.status(400).json(rpcError(null, -32600, 'Invalid request.')); return; }
      for (const call of calls) {
        const refusal = refuseCall(call);
        if (refusal) { res.status(400).json(rpcError((call as RpcCall)?.id, -32601, refusal)); return; }
      }
      const clean = calls.map(call => ({ jsonrpc: '2.0', id: call.id ?? null, method: call.method, ...(call.params !== undefined ? { params: call.params } : {}) }));
      try {
        const result = await forward(upstream(), batch ? clean : clean[0]);
        res.status(result.status).json(result.json);
      } catch {
        res.status(502).json(rpcError(batch ? null : clean[0].id, -32603, 'Solana could not be reached. Try again in a moment.'));
      }
    });
  return router;
}
