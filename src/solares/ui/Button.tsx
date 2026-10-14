// Button label helper for the `.ui-btn*` classes (docs/UI_ARGUS_PARITY.md 4.4): a busy
// button keeps its width and shows a text label ("Waiting for your wallet…"), never a
// spinner alone. Both labels share one grid cell, so the button is as wide as the longer
// one; the inactive label is visibility:hidden and leaves the accessible name.
//
//   <button className="ui-btn-primary" aria-busy={busy || undefined} disabled={busy} onClick={confirm}>
//     <ButtonLabel busy={busy} label="Confirm in wallet" busyLabel="Waiting for your wallet…" />
//   </button>
import './ui.css';

export function ButtonLabel({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <span className="ui-btn-labels">
      <span data-active={!busy}>{label}</span>
      <span data-active={busy}>{busyLabel}</span>
    </span>
  );
}
