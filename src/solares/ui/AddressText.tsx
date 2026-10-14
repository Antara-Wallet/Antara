// AddressText (docs/UI_ARGUS_PARITY.md 4.4): the full address in mono, first and last 6
// characters in --fg and the middle in --muted. Never truncated in its full form, which
// is the only form a review may use. `form="short"` ("AKnL4N…aRSZ9") is for pills and rows.
// The optional copy button reports through the shell's toast: "Address copied." or
// "Clipboard unavailable. Select and copy the address."
import { COPY_MESSAGES, copyText, shortAddress, splitAddress } from './address';
import { Icon } from './Icon';
import { useToast } from './Toast';
import './ui.css';

export interface AddressTextProps {
  address: string;
  /** 'full' (default): every character, wrapped as needed. 'short': first 6, last 5. */
  form?: 'full' | 'short';
  /** Show a copy button. */
  copy?: boolean;
  /** Accessible name of the copy button. Default "Copy address". */
  copyLabel?: string;
  /** Toast after a successful copy. Default "Address copied." */
  copiedMessage?: string;
  className?: string;
}

export function AddressText({ address, form = 'full', copy = false, copyLabel = 'Copy address', copiedMessage = COPY_MESSAGES.copied, className }: AddressTextProps) {
  const toast = useToast();
  const parts = splitAddress(address);
  return (
    <span className={`ui-address${className ? ` ${className}` : ''}`} data-form={form}>
      {form === 'short' ? (
        <span className="ui-address-text" title={address}>{shortAddress(address)}</span>
      ) : (
        <span className="ui-address-text">
          <span className="ui-address-edge">{parts.head}</span>
          {parts.middle && <span className="ui-address-mid">{parts.middle}</span>}
          {parts.tail && <span className="ui-address-edge">{parts.tail}</span>}
        </span>
      )}
      {copy && (
        <button
          type="button"
          className="ui-address-copy"
          aria-label={copyLabel}
          onClick={async () => toast.show((await copyText(address)) === 'copied' ? copiedMessage : COPY_MESSAGES.unavailable)}
        >
          <Icon name="copy" size={15} />
        </button>
      )}
    </span>
  );
}
