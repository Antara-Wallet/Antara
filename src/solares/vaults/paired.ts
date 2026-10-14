import { isAddress } from 'viem';
import { isNetworkKey } from '../networks';
import type { WalletChain } from '../wallet/types';

export type PairedVaultDiscovery = {
  owner: string;
  chain: WalletChain;
  creationEnabled: false;
  transfersEnabled: false;
} & ({ status: 'unavailable' | 'unsupported' | 'not-created' } | { status: 'deployed'; address: string; cosigner: string });

/** Bind every result to the selected wallet/network before showing any funds. */
export function parsePairedVault(value: unknown, owner: string, chain: WalletChain): PairedVaultDiscovery {
  // Fail closed: Arbitrum, Polygon and unknown networks are never paired.
  if (!isNetworkKey(chain)) throw new Error('This network is not supported by ANTARA.');
  const result = value as PairedVaultDiscovery;
  const sameOwner = chain === 'solana' ? result?.owner === owner : result?.owner?.toLowerCase() === owner.toLowerCase();
  if (!sameOwner || result?.chain !== chain || result.creationEnabled !== false || result.transfersEnabled !== false ||
    !['unavailable', 'unsupported', 'not-created', 'deployed'].includes(result?.status)) throw new Error('The vault response did not match this wallet. Retry the check.');
  if (result.status === 'deployed' && (chain === 'solana' || !isAddress(result.address) || !isAddress(result.cosigner) || result.cosigner.toLowerCase() === owner.toLowerCase())) {
    throw new Error('The paired vault could not be verified.');
  }
  return result;
}
