// Per-wallet settings: the cog on every wallet row (account sheet and Settings › Wallets)
// and the sheet it opens. The sheet shows the full address (copy), where to view it, and:
// - for the ANTARA (Privy embedded) wallet, "Export private key": an ANTARA warning step
//   first, then Privy's secure export window (wallet.exportWallet). The key is shown only
//   inside Privy's iframe on Privy's origin; ANTARA never receives, logs, stores or copies it.
// - for an external wallet, guidance to export from that wallet's own app (no button).
//
// The warning says what the export really hands over. For the EVM wallet Privy's window also
// offers a recovery phrase, and for Privy's legacy wallets that phrase restores the ANTARA Solana
// wallet too (its Solana wallet derives from the primary EVM wallet's entropy), which is the
// vault's owner key. The vault line appears only when the selected ANTARA Solana wallet really
// has a vault (summary `active` or `registered`).
//
// Asserted by the browser specs: the cog is a button named "Wallet settings for <name> …";
// the sheet is a dialog named "Wallet settings"; the warning step shows "Before you export".
import { useId, useRef, useState } from 'react';
import { AddressText, ButtonLabel, Icon, Sheet, shortAddress } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { ExternalLink } from '../../platform/ExternalLink';
import { useSolaresWallet, type WalletSigner } from '../wallet';
import { SOLANA_CLUSTER } from '../wallet/config';
import { usePairedVaultSummary } from '../vaults/summary';
import { exportChainFor, exportErrorMessage, walletExplorers, walletIdentity, type WalletFamily } from '../wallet/walletIdentity';
import './walletSettings.css';

export interface WalletSettingsButtonProps {
  family: WalletFamily;
  signer: WalletSigner;
  className?: string;
}

/** The cog. Owns its sheet, so it can sit in any list; focus returns to it on close. */
export function WalletSettingsButton({ family, signer, className }: WalletSettingsButtonProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const identity = walletIdentity(signer, family);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`ui-icon-btn wset-cog${className ? ` ${className}` : ''}`}
        aria-label={`Wallet settings for ${identity.label} ${shortAddress(signer.address)}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="settings" size={17} />
      </button>
      {open && <WalletSettingsSheet family={family} signer={signer} returnFocusTo={button.current} onClose={() => setOpen(false)} />}
    </>
  );
}

export interface WalletSettingsSheetProps {
  family: WalletFamily;
  signer: WalletSigner;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

export function WalletSettingsSheet({ family, signer, onClose, returnFocusTo }: WalletSettingsSheetProps) {
  const wallet = useSolaresWallet();
  const id = useId();
  const identity = walletIdentity(signer, family);
  const explorers = walletExplorers(family, signer.address, SOLANA_CLUSTER);
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closedNotice, setClosedNotice] = useState(false);
  const exportButton = useRef<HTMLButtonElement>(null);

  function startExport() { setError(''); setClosedNotice(false); setUnderstood(false); setStep('confirm'); }
  function backToDetails() {
    setStep('details'); setError(''); setUnderstood(false);
    requestAnimationFrame(() => exportButton.current?.focus());
  }
  async function openPrivyExport() {
    if (!understood || busy) return;
    setBusy(true); setError('');
    try {
      // Resolves with nothing when Privy's window closes; the key never leaves Privy's iframe.
      await wallet.exportWallet(exportChainFor(family), signer.address);
      setClosedNotice(true);
      backToDetails();
    } catch (failure) {
      setError(exportErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const familyName = family === 'solana' ? 'Solana' : 'EVM';
  // A vault exists only for the selected ANTARA Solana wallet, and only once it is registered.
  const vaultSummary = usePairedVaultSummary();
  const antaraSolanaSelected = wallet.solanaSigners.some(item => item.embedded && item.address === wallet.addresses.solana);
  const hasVault = antaraSolanaSelected && (vaultSummary.state === 'active' || vaultSummary.state === 'registered');
  // The Solana wallet that owns it, or the EVM wallet whose recovery phrase can restore that wallet.
  const vaultLine = hasVault && (family === 'evm' || signer.address === wallet.addresses.solana);
  const secret = family === 'evm' ? 'this key or recovery phrase' : 'this key';
  return (
    <Sheet
      title="Wallet settings"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      busy={busy}
      className="wset-sheet"
      headerStart={step === 'confirm' ? (
        <button type="button" className="ui-icon-btn" aria-label="Back to wallet settings" disabled={busy} onClick={backToDetails}>
          <Icon name="back" />
        </button>
      ) : undefined}
    >
      <div className="wset">
        <div className="wset-identity">
          <span className="wset-logo" aria-hidden="true"><TokenLogo symbol={family === 'solana' ? 'solana' : 'ethereum'} /></span>
          <span className="wset-identity-text">
            <span className="wset-name">
              <strong>{identity.label}</strong>
              {identity.hint && <span className="wset-tag">{identity.hint}</span>}
            </span>
            <small>{identity.embedded ? `${familyName} · In your ANTARA account` : `${familyName} · Keys held by ${identity.app}`}</small>
          </span>
        </div>

        {step === 'details' ? (
          <>
            <section className="wset-section" aria-labelledby={`${id}-address`}>
              <h3 id={`${id}-address`} className="wset-label ui-eyebrow">Address</h3>
              <div className="wset-address">
                <AddressText address={signer.address} copy copyLabel={`Copy ${identity.label} address`} />
              </div>
            </section>

            <section className="wset-section" aria-labelledby={`${id}-explorer`}>
              <h3 id={`${id}-explorer`} className="wset-label ui-eyebrow">View on explorer</h3>
              <ul className="wset-links">
                {explorers.map(link => (
                  <li key={link.url}>
                    <ExternalLink className="wset-link" href={link.url} aria-label={`View on ${link.name} (${link.network})`}>
                      <span className="wset-link-text">
                        <span>{link.name}</span>
                        <small>{link.network}</small>
                      </span>
                      <Icon name="external" size={15} />
                    </ExternalLink>
                  </li>
                ))}
              </ul>
            </section>

            <section className="wset-section" aria-labelledby={`${id}-key`}>
              <h3 id={`${id}-key`} className="wset-label ui-eyebrow">Private key</h3>
              {identity.embedded ? (
                <div className="wset-panel">
                  <p>Move this wallet to another wallet app with its private key. Privy shows the key in its own secure window; ANTARA never sees it.</p>
                  <button ref={exportButton} type="button" className="ui-btn wset-export" onClick={startExport}>
                    <Icon name="key" size={16} /> Export private key
                  </button>
                  {closedNotice && <p className="wset-note" role="status">Privy’s export window closed. ANTARA never received your key.</p>}
                </div>
              ) : (
                <div className="wset-panel">
                  <h4>Export from {identity.app}</h4>
                  <p>This wallet’s keys stay in {identity.app}. ANTARA never holds them, so it can’t export them. To back up or move this wallet, use {identity.app}’s own settings.</p>
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="wset-confirm" aria-labelledby={`${id}-warning`}>
            <div className="wset-warning">
              <h3 id={`${id}-warning`}><Icon name="shield" size={17} /> Before you export</h3>
              <ul>
                <li><strong>Anyone with this key controls this wallet’s funds.</strong> Never share it, and never paste it into a website, chat or support form.</li>
                {family === 'evm' && (
                  <li><strong>Privy may also show a recovery phrase.</strong> It can restore your ANTARA Solana wallet too{hasVault ? ', which is your vault’s owner key' : ''}. Treat exporting it as exporting both wallets.</li>
                )}
                <li>{family === 'evm' ? 'The key and phrase appear' : 'The key appears'} only inside Privy’s secure window. ANTARA never sees, stores or copies it.</li>
                {vaultLine && <li>Your vault keeps its protection: releases still need ANTARA’s guardian and your protection layers, not just {secret}.</li>}
                <li>If you copy it, clear your clipboard afterwards. Clipboard history (Win+V on Windows) and clipboard sync can keep a copy.</li>
                <li>Privy may ask you to verify it’s you first.</li>
              </ul>
            </div>
            <label className="wset-ack">
              <input type="checkbox" checked={understood} disabled={busy} onChange={event => setUnderstood(event.target.checked)} />
              <span>I understand that anyone with {secret} controls this wallet’s funds.</span>
            </label>
            {error && <p className="ui-alert wset-error" role="alert">{error}</p>}
            <div className="wset-actions">
              <button type="button" className="ui-btn" disabled={busy} onClick={backToDetails}>Cancel</button>
              <button type="button" className="ui-btn-primary" disabled={!understood || busy} aria-busy={busy || undefined} onClick={() => void openPrivyExport()}>
                <ButtonLabel busy={busy} label="Continue to secure export" busyLabel="Waiting for Privy…" />
              </button>
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
