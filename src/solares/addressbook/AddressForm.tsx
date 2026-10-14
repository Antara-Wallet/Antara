// Add or edit one saved address (docs/UI_ARGUS_PARITY.md 6.9; ARGUS S12,
// argus-ext-popup-13-address-book-add.png). Name 1–40 characters, the network family
// (Solana first) and the address. The store validates and refuses with the exact copy;
// nothing is saved until it accepts.
import { useId, useRef, useState, type FormEvent } from 'react';
import { ButtonLabel, Sheet, useToast } from '../ui';
import { AddressBookError, MAX_LABEL_LENGTH, saveEntry, type AddressEntry, type AddressFamily } from './store';
import { FAMILY_OPTIONS } from './family';
import './addressbook.css';

export interface AddressFormProps {
  privyUserId: string;
  /** Edit this entry; omit to add. */
  entry?: AddressEntry;
  /** Prefill for a new entry (e.g. "Save this address" after a send). */
  initial?: { label?: string; family?: AddressFamily; address?: string };
  /** Lock the family (the address came from a transfer on a known network). */
  lockFamily?: boolean;
  onClose: () => void;
  onSaved?: (entry: AddressEntry) => void;
}

export function AddressForm({ privyUserId, entry, initial, lockFamily = false, onClose, onSaved }: AddressFormProps) {
  const id = useId();
  const toast = useToast();
  const [label, setLabel] = useState(entry?.label ?? initial?.label ?? '');
  const [family, setFamily] = useState<AddressFamily>(entry?.family ?? initial?.family ?? 'solana');
  const [address, setAddress] = useState(entry?.address ?? initial?.address ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const saved = saveEntry(privyUserId, { label, family, address }, entry?.id);
      toast.show(entry ? 'Address updated.' : 'Address saved.');
      onSaved?.(saved);
      onClose();
    } catch (problem) {
      setError(problem instanceof AddressBookError ? problem.message : 'This address could not be saved. Nothing was changed.');
      setSaving(false);
    }
  }

  const formId = `${id}-form`;
  return (
    <Sheet
      title={entry ? 'Edit address' : 'Add address'}
      closeLabel="Close address form"
      onClose={onClose}
      busy={saving}
      initialFocus={nameRef}
      className="ab-form-sheet"
      footer={<>
        <button type="button" className="ui-btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" form={formId} className="ui-btn-primary" disabled={saving} aria-busy={saving || undefined}>
          <ButtonLabel busy={saving} label="Save" busyLabel="Saving…" />
        </button>
      </>}
    >
      <form id={formId} className="ab-form" onSubmit={submit} noValidate>
        <div className="ab-field">
          <label className="ab-field-label" htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            className="ab-input"
            value={label}
            onChange={event => { setLabel(event.target.value); setError(''); }}
            placeholder="For example, Savings"
            autoComplete="off"
            maxLength={MAX_LABEL_LENGTH * 2}
            aria-describedby={`${id}-name-hint`}
          />
          <span className="ab-field-hint" id={`${id}-name-hint`}>Up to {MAX_LABEL_LENGTH} characters. Only you see it, on this device.</span>
        </div>
        <fieldset className="ab-field ab-family" disabled={lockFamily}>
          <legend className="ab-field-label">Network family</legend>
          {FAMILY_OPTIONS.map(option => (
            <label key={option.value} className="ab-radio" data-checked={family === option.value || undefined}>
              <input type="radio" name={`${id}-family`} value={option.value} checked={family === option.value} onChange={() => { setFamily(option.value); setError(''); }} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="ab-field">
          <span className="ab-field-label">Address</span>
          <input
            className="ab-input ab-address-input"
            value={address}
            onChange={event => { setAddress(event.target.value); setError(''); }}
            placeholder={family === 'solana' ? 'Solana wallet address' : '0x…'}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={128}
          />
        </label>
        {error && <p className="ui-alert" role="alert">{error}</p>}
      </form>
    </Sheet>
  );
}
