import type { ReactNode } from 'react';
import './protection.css';

export { ProtectionScreen, type ProtectionScreenProps } from './ProtectionScreen';

export interface ProtectionOverviewProps {
  onOpenProtection: () => void;
  onOpenVaults: () => void;
}

/** Entry points, not a claim about the protection of a connected account. */
export function ProtectionOverview({ onOpenProtection, onOpenVaults }: ProtectionOverviewProps) {
  return <section className="antara-protection-overview" aria-label="Wallet protection">
    <button type="button" className="antara-protection-entry" onClick={onOpenProtection} aria-label="Open protection">
      <span className="antara-protection-entry-art" aria-hidden="true" />
      <span className="antara-protection-entry-label">THE ANTARA VISION</span>
      <span className="antara-protection-entry-title">Toward quantum-resistant safety</span>
      <span className="antara-protection-entry-description">The next horizon for layered wallet protection.</span>
      <span className="antara-protection-entry-action">Open protection <span aria-hidden="true">→</span></span>
    </button>
    <button type="button" className="antara-protection-entry antara-protection-entry-vault" onClick={onOpenVaults} aria-label="Open your vault">
      <span className="antara-protection-entry-art" aria-hidden="true" />
      <span className="antara-protection-entry-label">YOUR WALLET’S VAULT</span>
      <span className="antara-protection-entry-title">One wallet. A dedicated vault.</span>
      <span className="antara-protection-entry-description">Everyday funds and your vault, together in one place.</span>
      <span className="antara-protection-entry-action">Open your vault <span aria-hidden="true">→</span></span>
    </button>
  </section>;
}

export interface ProtectionWorkspaceProps {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  onConnect: () => void;
  onVaults: () => void;
  /** Unused and optional: there is no wallet MFA (owner decision 2026-10-13). */
  onMfa?: () => void;
}

function ProtectionLayer({ number, title, status, children }: { number: string; title: string; status?: string; children: ReactNode }) {
  return <article className="antara-protection-layer">
    <div className="antara-protection-layer-top"><span className="antara-protection-layer-number" aria-hidden="true">{number}</span>{status && <span className="antara-protection-status">{status}</span>}</div>
    <h3>{title}</h3>
    {children}
  </article>;
}

/** Status stays unverified until the relevant provider or vault supplies evidence. */
export function ProtectionWorkspace({ configured, ready, authenticated, onConnect, onVaults }: ProtectionWorkspaceProps) {
  const canSignIn = configured && ready && !authenticated;
  return <section className="antara-protection" aria-labelledby="antara-protection-title">
    <header className="protection-page-heading"><h2 id="antara-protection-title">Protect your wallet</h2><p>Your wallet verification and vault settings, in one place.</p></header>
    <section className="antara-protection-layers" aria-label="Protection layers">
      <ProtectionLayer number="01" title="Your wallet’s vault" status="Managed inside your wallet">
        <p>Open the Vault tab beside Wallet to see the vault paired with your selected wallet and its security settings.</p>
        <button type="button" className="antara-protection-action" onClick={onVaults}>Open your vault <span aria-hidden="true">→</span></button>
      </ProtectionLayer>

      <ProtectionLayer number="02" title="Vault authenticator (MFA)" status="Optional · per vault">
        <p>Turn on MFA for your vault and every release needs a 6-digit code from an authenticator app such as Google Authenticator. Your regular wallet has no MFA.</p>
        {canSignIn ? <button type="button" className="antara-protection-action" onClick={onConnect}>Sign in to set it up <span aria-hidden="true">→</span></button>
          : configured ? <button type="button" className="antara-protection-action" onClick={onVaults} disabled={!authenticated}>{!ready ? 'Wallet loading…' : 'Set up in your vault'}<span aria-hidden="true">→</span></button>
          : <p className="antara-protection-next-step">Set up sign-in in Settings to continue.</p>}
      </ProtectionLayer>

      {/* No status here: a layer's status is shown only inside the vault, from ANTARA's answer for that vault. */}
      <ProtectionLayer number="03" title="Vault protection layers">
        <p>A passkey, plus optional authenticator app, safe zones, networks, Bluetooth devices and your own caps for your vault’s releases. Set them up and see their status in your vault’s settings.</p>
        <button type="button" className="antara-protection-action" onClick={onVaults}>Open vault protection layers <span aria-hidden="true">→</span></button>
      </ProtectionLayer>

    </section>

    <p className="antara-protection-footnote">Vault protection applies only to funds in an activated vault. Wallet verification is managed separately.</p>
  </section>;
}

export default ProtectionWorkspace;
