import type { Chain } from 'viem';
import { base, bsc, mainnet, robinhood } from 'viem/chains';
import { SUPPORTED_EVM_NETWORKS, byEvmChainId, byKey, type EvmNetworkKey } from './networks';

/**
 * viem chain objects for the supported EVM networks. Default RPCs are pinned to
 * the registry's official/keyless endpoints, because several viem defaults
 * (BNB Smart Chain, Robinhood Chain websocket) are third-party gateways. Pass a
 * configured endpoint explicitly (for example with Privy's
 * addRpcUrlOverrideToChain or viem `http(url)`) to use a dedicated RPC.
 * Shared by the frontend and the API server; both pin viem 2.57.4.
 */
function pinned(source: Chain, key: EvmNetworkKey): Chain {
  const network = byKey(key);
  if (source.id !== network.evmChainId) throw new Error(`viem chain ${source.id} does not match ${network.name}.`);
  return { ...source, name: network.name, rpcUrls: { ...source.rpcUrls, default: { http: [...network.rpc.defaults] } } };
}

export const VIEM_CHAINS: Readonly<Record<EvmNetworkKey, Chain>> = Object.freeze({
  ethereum: pinned(mainnet, 'ethereum'),
  bsc: pinned(bsc, 'bsc'),
  robinhood: pinned(robinhood, 'robinhood'),
  base: pinned(base, 'base'),
});
/** Supported viem chains in display order: Ethereum, BNB Smart Chain, Robinhood Chain, Base. */
export const SUPPORTED_VIEM_CHAINS: readonly Chain[] = Object.freeze(SUPPORTED_EVM_NETWORKS.map(network => VIEM_CHAINS[network.key]));

/** Fail-closed: Arbitrum, Polygon and unknown ids are not supported. */
export function viemChainFor(chainId: number): Chain {
  const network = byEvmChainId(chainId);
  if (!network) throw new Error('This EVM network is not supported by ANTARA.');
  return VIEM_CHAINS[network.key];
}
