/** Pure address formatting and copy helpers behind AddressText (docs/UI_ARGUS_PARITY.md 4.4). */

export interface AddressParts {
  head: string;
  middle: string;
  tail: string;
}

/**
 * Splits a full address for display: the first and last `edge` characters are emphasised,
 * the middle is muted. Nothing is dropped; `head + middle + tail === address` always.
 * An address too short to have a middle is returned whole as `head`.
 */
export function splitAddress(address: string, edge = 6): AddressParts {
  const value = address.trim();
  if (value.length <= edge * 2) return { head: value, middle: '', tail: '' };
  return { head: value.slice(0, edge), middle: value.slice(edge, -edge), tail: value.slice(-edge) };
}

/**
 * Short form for pills and rows, "AKnL4N…aRSZ9" (first 6, last 5), matching the shell's
 * existing `shorten()`. Addresses of 16 characters or fewer are shown whole.
 * Never use it where the user confirms a recipient: reviews show the full address.
 */
export function shortAddress(address: string, head = 6, tail = 5): string {
  const value = address.trim();
  return value.length > 16 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export const COPY_MESSAGES = Object.freeze({
  copied: 'Address copied.',
  unavailable: 'Clipboard unavailable. Select and copy the address.',
});

export type CopyOutcome = 'copied' | 'unavailable';

/** Writes `text` to the clipboard. Never throws: a blocked or missing clipboard reports 'unavailable'. */
export async function copyText(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard): Promise<CopyOutcome> {
  if (!clipboard) return 'unavailable';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'unavailable';
  }
}
