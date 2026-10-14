// Gallery of the shared primitives in src/solares/ui (docs/UI_ARGUS_PARITY.md 4.4), for the
// parity runner's `ui-primitives` and `ui-sheet` scenarios and for areas checking how a
// primitive looks before using it. Browser-only; never imported by the application.
//   ?sheet=1   open the sample Sheet        ?toast=1   show the sample toast
//   ?surface=sidepanel  as the extension side panel (data-surface, extension.css)
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AddressText, ButtonLabel, EmptyState, ICON_NAMES, Icon, Sheet, StatusChip, Stepper, ToastProvider, useToast,
} from '../../src/solares/ui';
import { PARITY_EVM_WALLETS, PARITY_KEYS } from './keys';
import '../../src/index.css';
import '../../src/extension/extension.css';

const params = new URLSearchParams(location.search);
if (params.get('surface') === 'sidepanel') document.documentElement.dataset.surface = 'sidepanel';

function Gallery() {
  const toast = useToast();
  const [sheet, setSheet] = useState(params.get('sheet') === '1');
  const [nested, setNested] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (params.get('toast') === '1') toast.show('Address copied.'); }, [toast]);
  return (
    <main className="ui-scope" style={{ minHeight: '100dvh', background: 'var(--ink-1)', color: 'var(--fg)', font: '400 13px/1.5 var(--font-ui)', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gap: 16 }}>
        <header>
          <p className="ui-eyebrow" style={{ margin: 0 }}>ANTARA · ui primitives</p>
          <h1 style={{ margin: '4px 0 0', font: '550 28px/1.2 var(--font-display)', letterSpacing: '-.04em' }}>Shared components</h1>
        </header>

        <section className="ui-card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }} aria-label="Buttons">
          <button type="button" className="ui-btn-primary" onClick={() => setSheet(true)}>Open sheet</button>
          <button type="button" className="ui-btn" onClick={() => toast.show('Address copied.')}>Show toast</button>
          <button type="button" className="ui-btn-primary" aria-busy="true" disabled><ButtonLabel busy label="Confirm in wallet" busyLabel="Waiting for your wallet…" /></button>
          <button type="button" className="ui-btn-text">See all activity <Icon name="arrow" size={15} /></button>
          <button type="button" className="ui-btn-danger">Remove</button>
          <button type="button" className="ui-icon-btn" aria-label="Choose from address book"><Icon name="book" /></button>
        </section>

        <section className="ui-card" style={{ padding: 16, display: 'grid', gap: 12 }} aria-label="Addresses">
          <p className="ui-eyebrow" style={{ margin: 0 }}>AddressText</p>
          <AddressText address={PARITY_KEYS.user} copy copyLabel="Copy Solana address" copiedMessage="Solana address copied." />
          <AddressText address={PARITY_EVM_WALLETS[0].address} copy />
          <AddressText address={PARITY_KEYS.recipient} form="short" />
        </section>

        <section className="ui-card" style={{ padding: 16, display: 'grid', gap: 12 }} aria-label="Status">
          <p className="ui-eyebrow" style={{ margin: 0 }}>StatusChip · Stepper</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <StatusChip tone="neutral" label="Not activated" />
            <StatusChip tone="ok" label="Ready to send" />
            <StatusChip tone="warn" label="Add a passkey to finish" />
            <StatusChip tone="danger" label="Status unavailable" />
          </div>
          <Stepper steps={['Asset', 'Details', 'Review', 'Result']} current={1} />
          <p className="ui-alert" role="alert">Review expired. Go back and refresh the network fee.</p>
        </section>

        <section className="ui-card" aria-label="Empty state">
          <EmptyState art="observatory" title="No activity yet" text="Your transfers and swaps made here will appear on this device." action={<button type="button" className="ui-btn">Receive</button>} />
        </section>

        <section className="ui-card" style={{ padding: 16 }} aria-label="Icons">
          <p className="ui-eyebrow" style={{ margin: '0 0 10px' }}>Icon</p>
          <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
            {ICON_NAMES.map(name => (
              <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-2)', fontSize: 11 }}><Icon name={name} /> {name}</li>
            ))}
          </ul>
        </section>
      </div>

      {sheet && (
        <Sheet
          title="Receive"
          description="Sample sheet: focus trap, Escape, busy."
          onClose={() => setSheet(false)}
          busy={busy}
          closeLabel="Close receive"
          headerStart={<button type="button" className="ui-icon-btn" aria-label="Back"><Icon name="back" /></button>}
          footer={<>
            <button type="button" className="ui-btn" onClick={() => setNested(true)}>Open nested</button>
            <button type="button" className="ui-btn-primary" aria-busy={busy || undefined} onClick={() => setBusy(!busy)}>
              <ButtonLabel busy={busy} label="Start busy" busyLabel="Waiting for your wallet…" />
            </button>
          </>}
        >
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
              Search
              <input placeholder="Search assets or networks" style={{ minHeight: 40, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-2)', color: 'var(--fg)', padding: '0 12px', font: 'inherit' }} />
            </label>
            <AddressText address={PARITY_KEYS.user} copy />
            <p style={{ margin: 0, color: 'var(--muted)' }}>Only send assets on Solana to this address. Verify the network in the sending wallet.</p>
          </div>
        </Sheet>
      )}
      {nested && (
        <Sheet title="Address book" onClose={() => setNested(false)} size="large">
          <EmptyState title="No saved addresses yet" text="Addresses you save stay on this device for this account." />
        </Sheet>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToastProvider><Gallery /></ToastProvider></StrictMode>);
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
