import { SUPPORTED_EVM_NETWORKS, type EvmNetworkKey } from '../networks';

export type EvmRpcSetup =
  | { readonly ok: true; readonly urls: readonly { readonly key: EvmNetworkKey; readonly url: string }[] }
  | { readonly ok: false; readonly error: string };

/**
 * Browser RPC for every supported EVM network, in registry order. A malformed
 * public override is a visible configuration error that keeps sign-in disabled:
 * it never unmounts the app and never falls back to a default endpoint.
 */
export function resolveEvmRpcUrls(resolve: (key: EvmNetworkKey) => string): EvmRpcSetup {
  try {
    return { ok: true, urls: SUPPORTED_EVM_NETWORKS.map(network => ({ key: network.key, url: resolve(network.key) })) };
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
    return { ok: false, error: `EVM RPC configuration is invalid.${detail} Sign-in stays disabled until it is fixed.` };
  }
}
