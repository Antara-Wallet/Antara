// Mounts the same WalletApp the desktop and browser /app routes use. Extension
// pages always render the wallet (never the public landing page).
import React, { Suspense, lazy, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { layerCapabilities } from '../platform/layers';
import '../index.css';
import './extension.css';

const WalletApp = lazy(() => import('../solares/WalletApp'));

const fallback = (
  <div style={{ background: '#050507', height: 'calc(100vh - var(--extension-bar-height, 0px))', display: 'grid', placeItems: 'center', color: '#b9d9ff', letterSpacing: '.3em' }}>ANTARA</div>
);

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 280) || 'Unknown error.';
}

/**
 * A render error in the wallet (for example PrivyProvider rejecting its config)
 * would otherwise unmount the whole root and leave a blank panel. This shows a
 * plain failure message instead, never balances or account data.
 */
class WalletErrorBoundary extends React.Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('Unknown error.') };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[ANTARA extension] Wallet failed to start:', reasonOf(error), info.componentStack ?? '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="extension-failure" role="alert">
        <h1>Wallet failed to start</h1>
        <p className="extension-failure-reason">{reasonOf(this.state.error)}</p>
        <p>No account data was loaded. Reload to try again, or check the extension build configuration.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}

/**
 * Renders the wallet into #root. `chrome` is optional extension-only page chrome
 * (the side panel's "Open in full tab" bar), kept outside the error boundary so it
 * stays usable even when the wallet cannot start.
 */
export function mountWallet(chrome?: ReactNode) {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root.');
  // Where vault-layer ceremonies (passkey, Bluetooth chooser, location) run for this
  // page: "inline" in the full tab, "tab" (hand off to wallet.html) in the side panel.
  // Declared from the bundled layerCapabilities() so the headless extension tests
  // check the shipped decision, not a copy of it.
  document.documentElement.dataset.layerCeremony = layerCapabilities().ceremonyInline ? 'inline' : 'tab';
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      {chrome}
      <WalletErrorBoundary>
        <Suspense fallback={fallback}><WalletApp /></Suspense>
      </WalletErrorBoundary>
    </React.StrictMode>,
  );
}
