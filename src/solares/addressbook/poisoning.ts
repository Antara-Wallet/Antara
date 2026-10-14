/**
 * Address-poisoning check (docs/UI_ARGUS_PARITY.md 8.3). An attacker sends dust from an
 * address that shares the start and end of one you use, hoping you copy it from your
 * history. `lookalike()` flags an input that shares its first 4 **and** last 4
 * characters with a saved, own or recent address but is not that address.
 *
 * - EVM: compared without the `0x` prefix and case-insensitively (checksum casing is not
 *   identity), so "first 4" means four hex digits, not "0x" plus two.
 * - Solana: base58 is case-sensitive, so it is compared exactly.
 * - Inputs shorter than a full address are not checked: a warning while someone is
 *   still typing would be noise, and Send validates the address before review anyway.
 * - An input equal to a known address is recognised (a chip in Send), never a lookalike.
 *
 * Pure: no storage, no network.
 */

export interface LookalikeCandidate { label: string; address: string }

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Edge length compared at each end (8.3). */
export const LOOKALIKE_EDGE = 4;
/** Shortest Solana address (a 32-byte key in base58 is 32 to 44 characters). */
export const MIN_SOLANA_LENGTH = 32;

function comparable(address: string): { evm: boolean; body: string } {
  const value = address.trim();
  return EVM_ADDRESS.test(value) ? { evm: true, body: value.slice(2).toLowerCase() } : { evm: false, body: value };
}

export function lookalike(input: string, candidates: readonly LookalikeCandidate[]): LookalikeCandidate | null {
  const typed = comparable(input);
  if (!typed.evm && typed.body.length < MIN_SOLANA_LENGTH) return null;
  const sameKind = candidates
    .map(candidate => ({ candidate, ...comparable(candidate.address) }))
    .filter(item => item.evm === typed.evm && item.body.length >= LOOKALIKE_EDGE * 2);
  if (sameKind.some(item => item.body === typed.body)) return null;
  const head = typed.body.slice(0, LOOKALIKE_EDGE), tail = typed.body.slice(-LOOKALIKE_EDGE);
  return sameKind.find(item => item.body.slice(0, LOOKALIKE_EDGE) === head && item.body.slice(-LOOKALIKE_EDGE) === tail)?.candidate ?? null;
}

/** The warning Send shows for a lookalike (8.3, exact). */
export function lookalikeWarning(match: Pick<LookalikeCandidate, 'label'>): string {
  return `This address looks like ${match.label} but is different. Check every character.`;
}
