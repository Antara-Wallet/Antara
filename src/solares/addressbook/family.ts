/**
 * Address families for the address book, Send and Receive (docs/UI_ARGUS_PARITY.md 8.3).
 * Solana has its own addresses; every supported EVM network shares one address format.
 * Pure and dependency-free, so Receive can use it without loading the store.
 */
import { SUPPORTED_EVM_NETWORKS, type NetworkKey } from '../networks';

export type AddressFamily = 'solana' | 'evm';

/** Registry order: Solana first. */
export const ADDRESS_FAMILIES: readonly AddressFamily[] = Object.freeze(['solana', 'evm']);

export const familyOf = (chain: NetworkKey): AddressFamily => (chain === 'solana' ? 'solana' : 'evm');

/** Short chip text for a family. */
export const FAMILY_CHIP: Readonly<Record<AddressFamily, string>> = Object.freeze({ solana: 'Solana', evm: 'EVM' });

/** The address form's family choices (6.9), Solana first, EVM naming every network from the registry. */
export const FAMILY_OPTIONS: readonly { value: AddressFamily; label: string }[] = Object.freeze([
  { value: 'solana', label: 'Solana' },
  { value: 'evm', label: `EVM (${SUPPORTED_EVM_NETWORKS.map(network => network.name).join(', ')})` },
]);

/** Same account? Solana (base58) is case-sensitive; EVM hex is not. */
export function sameAddress(family: AddressFamily, a: string, b: string): boolean {
  const left = a.trim(), right = b.trim();
  return family === 'evm' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
