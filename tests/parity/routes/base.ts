/**
 * Area A base routes (docs/UI_ARGUS_PARITY.md 10.2). Installed first, so it is
 * consulted last:
 * - the page's own server (the Vite dev server) is served as is, except `/api/**`;
 * - `/api/solares/wallet/prices` answers the prices Relay returned on 2026-10-14
 *   (server/src/solares/fixtures/relay-prices), stamped at PARITY_TIME;
 * - `/api/**` that no later module answered gets 501 and is logged as unmocked;
 * - `https://rpc.parity.invalid` is a fake Solana JSON-RPC (also answering the page's
 *   same-origin proxy `POST /api/solares/rpc/solana`), and
 *   `https://<network>.rpc.parity.invalid` fake EVM JSON-RPCs (both extensible
 *   through `ctx.rpc`);
 * - every other request is aborted and logged. Nothing leaves the machine.
 */
import { SUPPORTED_NETWORKS } from '../../../src/solares/networks';
import { PARITY_KEYS } from '../keys';
import { PARITY_TIME, fulfillJson, type RouteInstaller, type RpcHandler, type RpcRegistry } from '../types';

/** The public GET /api/solares/wallet/prices answer (server/src/solares/prices.ts) with captured Relay prices. */
export const PARITY_PRICES = Object.freeze({
  prices: {
    solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } },
    ethereum: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    bsc: { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    robinhood: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999881, symbol: 'USDG' } },
    base: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
  },
  observedAt: PARITY_TIME.toISOString(),
  source: 'Relay',
});

/** Solana mainnet genesis hash; the cluster check reads it. */
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** A fixed, valid base58 32-byte blockhash (Keypair-derived, never a real block). */
const BLOCKHASH = PARITY_KEYS.createKey;
const context = (slot = 1) => ({ apiVersion: '2.0.0', slot });

/** Default answers. The harness supplies wallet balances itself; these cover what the UI reads directly. */
const SOLANA_DEFAULTS: Record<string, (params: unknown[]) => unknown> = {
  getLatestBlockhash: () => ({ context: context(), value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } }),
  getFeeForMessage: () => ({ context: context(), value: 5_000 }),
  getBalance: params => ({ context: context(), value: params[0] === PARITY_KEYS.user ? 1_250_000_000 : 0 }),
  getAccountInfo: () => ({ context: context(), value: null }),
  getMultipleAccounts: params => ({ context: context(), value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) }),
  getTokenAccountBalance: () => ({ context: context(), value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } }),
  getTokenAccountsByOwner: () => ({ context: context(), value: [] }),
  getMinimumBalanceForRentExemption: () => 2_039_280,
  getRecentPrioritizationFees: () => [],
  simulateTransaction: () => ({ context: context(), value: { err: null, logs: [], accounts: null, unitsConsumed: 1_000, returnData: null } }),
  getSignatureStatuses: params => ({ context: context(), value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) }),
  getSlot: () => 1,
  getBlockHeight: () => 1,
  getEpochInfo: () => ({ absoluteSlot: 1, blockHeight: 1, epoch: 0, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 0 }),
  getVersion: () => ({ 'solana-core': '2.0.0', 'feature-set': 0 }),
  getGenesisHash: () => MAINNET_GENESIS,
  getHealth: () => 'ok',
};

const EVM_DEFAULTS: Record<string, (params: unknown[], chainId: number) => unknown> = {
  eth_chainId: (_params, chainId) => `0x${chainId.toString(16)}`,
  net_version: (_params, chainId) => String(chainId),
  eth_blockNumber: () => '0x1',
  eth_getBalance: () => '0x0',
  eth_getTransactionCount: () => '0x0',
  eth_getCode: () => '0x',
  eth_call: () => '0x0000000000000000000000000000000000000000000000000000000000000000',
  eth_gasPrice: () => '0x3b9aca00',
  eth_maxPriorityFeePerGas: () => '0x3b9aca00',
  eth_estimateGas: () => '0x5208',
  eth_getBlockByNumber: () => ({ number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x0', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] }),
  eth_feeHistory: () => ({ oldestBlock: '0x1', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
};

/** host → chain id for the fake EVM RPCs (https://<network key>.rpc.parity.invalid). */
const EVM_HOSTS = new Map(SUPPORTED_NETWORKS.filter(network => network.vm === 'evm').map(network => [`${network.key}.rpc.parity.invalid`, Number(network.evmChainId)]));

/** Creates the registry the runner passes to every module as `ctx.rpc`. */
export function createRpcRegistry(): RpcRegistry & { solanaHandlers: Map<string, RpcHandler[]>; evmHandlers: Map<string, RpcHandler[]> } {
  const solanaHandlers = new Map<string, RpcHandler[]>();
  const evmHandlers = new Map<string, RpcHandler[]>();
  const add = (map: Map<string, RpcHandler[]>, method: string, handler: RpcHandler) => map.set(method, [handler, ...(map.get(method) ?? [])]);
  return {
    solanaHandlers, evmHandlers,
    solana: (method, handler) => add(solanaHandlers, method, handler),
    evm: (method, handler) => add(evmHandlers, method, handler),
  };
}

interface JsonRpcCall { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown }

async function answer(call: JsonRpcCall, url: URL, handlers: Map<string, RpcHandler[]>, fallback: ((params: unknown[]) => unknown) | undefined, unmocked: string[]) {
  const method = typeof call.method === 'string' ? call.method : '';
  const params = Array.isArray(call.params) ? call.params : [];
  for (const handler of handlers.get(method) ?? []) {
    const result = await handler(params, { url, method });
    if (result !== undefined) return { jsonrpc: '2.0', id: call.id ?? null, result };
  }
  if (fallback) return { jsonrpc: '2.0', id: call.id ?? null, result: fallback(params) };
  unmocked.push(`${url.host} ${method || '(no method)'}`);
  return { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32601, message: `Parity fake: ${method} is not mocked` } };
}

export const install: RouteInstaller = async (browserContext, ctx) => {
  const registry = ctx.rpc as ReturnType<typeof createRpcRegistry>;
  const origin = new URL(ctx.origin);
  // Every WebSocket is a silent mock that never connects: the Solana subscription socket, and
  // also the dev server's own HMR socket, so a file saved by another workflow mid-run cannot
  // hot-reload the page under a capture. The socket stays open, so the Vite client never
  // starts its reconnect-and-reload polling.
  await browserContext.routeWebSocket(() => true, () => { /* silent mock: no server, no messages */ });
  await browserContext.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.host === origin.host) {
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/solares/wallet/prices' && route.request().method() === 'GET') return fulfillJson(route, 200, PARITY_PRICES);
      // ANTARA's same-origin Solana JSON-RPC proxy (server/src/solares/solanaRpcProxy.ts), which the page uses
      // whenever it has an API origin: answered by the same fake Solana RPC as https://rpc.parity.invalid.
      if (url.pathname === '/api/solares/rpc/solana' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as JsonRpcCall | JsonRpcCall[] | null;
        const calls = Array.isArray(body) ? body : body ? [body] : [];
        const answers = await Promise.all(calls.map(call => answer(call, url, registry.solanaHandlers, SOLANA_DEFAULTS[String(call.method)], ctx.log.rpcUnmocked)));
        return fulfillJson(route, 200, Array.isArray(body) ? answers : answers[0] ?? null);
      }
      ctx.log.unmocked.push(`${route.request().method()} ${url.pathname}${url.search}`);
      return fulfillJson(route, 501, { error: 'not-mocked', message: 'Parity harness: no route module answers this API path.' });
    }
    if (url.protocol === 'https:' && url.host === 'rpc.parity.invalid') {
      const body = route.request().postDataJSON() as JsonRpcCall | JsonRpcCall[] | null;
      const calls = Array.isArray(body) ? body : body ? [body] : [];
      const answers = await Promise.all(calls.map(call => answer(call, url, registry.solanaHandlers, SOLANA_DEFAULTS[String(call.method)], ctx.log.rpcUnmocked)));
      return fulfillJson(route, 200, Array.isArray(body) ? answers : answers[0] ?? null);
    }
    const chainId = url.protocol === 'https:' ? EVM_HOSTS.get(url.host) : undefined;
    if (chainId !== undefined) {
      const body = route.request().postDataJSON() as JsonRpcCall | JsonRpcCall[] | null;
      const calls = Array.isArray(body) ? body : body ? [body] : [];
      const answers = await Promise.all(calls.map(call => {
        const fallback = EVM_DEFAULTS[String(call.method)];
        return answer(call, url, registry.evmHandlers, fallback && (params => fallback(params, chainId)), ctx.log.rpcUnmocked);
      }));
      return fulfillJson(route, 200, Array.isArray(body) ? answers : answers[0] ?? null);
    }
    ctx.log.blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
};
