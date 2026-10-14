// Receive in two steps (docs/UI_ARGUS_PARITY.md 6.7; ARGUS S13,
// argus-ext-popup-14-receive.png, 15-receive-qr-full.png).
//
// Step 1 lists the ten receivable assets in registry order (Solana first), grouped by
// network, each with QR and Copy. The Network select marks the network you are
// receiving on and shows its stablecoin identity. Step 2 is the QR with the token mark,
// the full address and the network notes.
//
// Wallet side: only your spending-wallet addresses. Vault side (`side="vault"`): only the
// vault's chain-verified deposit address, and only when the vault summary is `active`;
// otherwise the vault's reason, with no address and no QR.
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useSolaresWallet } from '../wallet';
import { SUPPORTED_NETWORKS } from '../networks';
import type { WalletChain } from '../wallet/types';
import { AddressText, COPY_MESSAGES, Icon, Sheet, copyText, useToast } from '../ui';
import { TokenLogo } from '../TokenLogo';
import {
  RECEIVE_COPY, VAULT_DEPOSIT_NOTE, addressHeading, assetRows, copiedMessage, filterRows, networkDisplayName, networkNote,
  receiveHeading, stablecoinLine, vaultRows, walletAddressFor, type AssetKind, type AssetRow,
} from './receiveModel';
import { vaultReceiveState, type VaultSummaryInput } from './vaultTarget';
import './receive.css';

export interface ReceiveSheetProps {
  initialChain: WalletChain;
  /** With an asset (Token detail), the sheet opens on that asset's QR. */
  initialAsset?: AssetKind;
  side?: 'wallet' | 'vault';
  onClose: () => void;
  onSignIn: () => void;
  /** Additive to 8.1: the vault summary (8.2), required for the vault side. Absent means "Finding your vault". */
  vaultSummary?: VaultSummaryInput | null;
  /** Additive to 8.1: where focus returns on close. Default: the control that opened the sheet. */
  returnFocusTo?: HTMLElement | null;
}

export function ReceiveSheet({ initialChain, initialAsset, side = 'wallet', onClose, onSignIn, vaultSummary, returnFocusTo }: ReceiveSheetProps) {
  const wallet = useSolaresWallet();
  const toast = useToast();
  const vaultSide = side === 'vault';
  const rows = useMemo(() => (vaultSide ? vaultRows() : assetRows()), [vaultSide]);
  const [network, setNetwork] = useState<WalletChain>(vaultSide ? 'solana' : initialChain);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(() => (initialAsset ? `${vaultSide ? 'solana' : initialChain}:${initialAsset}` : null));
  const lastRow = useRef<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());

  const vault = vaultSide ? vaultReceiveState(vaultSummary) : null;
  const addresses = wallet.authenticated ? wallet.addresses : { solana: null, ethereum: null };
  const addressOf = (row: AssetRow): string | null => {
    if (row.unavailable || !wallet.authenticated) return null;
    if (vault) return vault.kind === 'ready' ? vault.address : null;
    return walletAddressFor(row.family, addresses);
  };
  const row = selected ? rows.find(item => item.key === selected) : undefined;
  const address = row ? addressOf(row) : null;
  const stepKey = row && address ? `qr:${row.key}` : 'list';

  useEffect(() => {
    // Move focus with the step, after the first render (the Sheet focuses itself on open).
    if (stepKey === 'list' && lastRow.current) {
      stepRef.current?.querySelector<HTMLElement>(`[data-row-key="${lastRow.current}"] button`)?.focus();
    } else if (stepKey !== 'list') stepRef.current?.focus();
  }, [stepKey]);

  async function copy(target: AssetRow) {
    const value = addressOf(target);
    if (!value) return;
    toast.show((await copyText(value)) === 'copied' ? copiedMessage(target, side) : COPY_MESSAGES.unavailable);
  }
  function chooseNetwork(chain: WalletChain) {
    setNetwork(chain);
    // Bring that network's assets into view; no animation, so reduced motion is honoured.
    requestAnimationFrame(() => groupRefs.current.get(chain)?.scrollIntoView({ block: 'nearest' }));
  }

  if (row && address) {
    return (
      <Sheet
        title={receiveHeading(row)}
        closeLabel="Close receive"
        onClose={onClose}
        returnFocusTo={returnFocusTo}
        fullScreenNarrow
        className="rcv-sheet"
        headerStart={<button type="button" className="ui-icon-btn" aria-label="Back to assets" onClick={() => { lastRow.current = row.key; setSelected(null); }}><Icon name="back" /></button>}
        footer={<button type="button" className="ui-btn-primary rcv-copy" onClick={() => void copy(row)}><Icon name="copy" size={17} /> Copy address</button>}
      >
        <div ref={stepRef} tabIndex={-1} className="rcv-step rcv-qr-step" data-screen="receive-qr">
          <SideTag vault={vaultSide} />
          <div className="rcv-qr" data-value={address}>
            <QRCodeSVG value={address} size={200} level="H" fgColor="#0c1c35" bgColor="#f2f7ff" marginSize={2} title={`QR code of ${addressHeading(row, side).toLowerCase()}`} />
            <span className="rcv-qr-mark" aria-hidden="true"><TokenLogo symbol={row.mark} /></span>
          </div>
          <p className="rcv-qr-asset">{row.label}<span> · {row.network}</span></p>
          <div className="rcv-address">
            <p className="rcv-address-label">{addressHeading(row, side)}</p>
            <div className="rcv-address-box"><AddressText address={address} /></div>
          </div>
          <div className="rcv-notes">
            <p>{vaultSide ? VAULT_DEPOSIT_NOTE : networkNote(row.chain)}</p>
            {!vaultSide && row.asset === 'stablecoin' && stablecoinLine(row.chain) && <p>{stablecoinLine(row.chain)}</p>}
          </div>
        </div>
      </Sheet>
    );
  }

  const visible = filterRows(rows, query);
  const groups = SUPPORTED_NETWORKS.map(item => ({ chain: item.key, name: networkDisplayName(item.key), rows: visible.filter(entry => entry.chain === item.key) })).filter(group => group.rows.length);
  const identity = !vaultSide ? stablecoinLine(network) : '';
  return (
    <Sheet title="Receive" closeLabel="Close receive" onClose={onClose} returnFocusTo={returnFocusTo} className="rcv-sheet">
      <div ref={stepRef} tabIndex={-1} className="rcv-step" data-screen="receive">
        <SideTag vault={vaultSide} />
        {!vaultSide && (
          <div className="rcv-network">
            <label className="rcv-field">
              <span className="rcv-field-label">Network</span>
              <select className="rcv-select" value={network} onChange={event => chooseNetwork(event.target.value as WalletChain)}>
                {SUPPORTED_NETWORKS.map(item => <option key={item.key} value={item.key}>{networkDisplayName(item.key)}</option>)}
              </select>
            </label>
            {identity && <p className="rcv-identity">{identity}</p>}
          </div>
        )}

        {!wallet.authenticated ? (
          <div className="ui-card rcv-signed-out">
            <span className="rcv-signed-out-icon" aria-hidden="true"><Icon name="down" size={22} /></span>
            <h3>{RECEIVE_COPY.signedOutTitle}</h3>
            <p>{RECEIVE_COPY.signedOutText}</p>
            <button type="button" className="ui-btn-primary" onClick={() => { onClose(); onSignIn(); }}>{wallet.configured ? 'Sign in' : 'Open setup'}</button>
          </div>
        ) : vault?.kind === 'blocked' ? (
          <div className="ui-card rcv-blocked" role="status">
            <span className="rcv-signed-out-icon" aria-hidden="true"><Icon name="lock" size={22} /></span>
            <h3>{vault.title}</h3>
            {vault.reason && <p>{vault.reason}</p>}
          </div>
        ) : (
          <>
            {!vaultSide && (
              <label className="rcv-search">
                <Icon name="search" size={16} />
                <input type="search" className="rcv-search-input" placeholder={RECEIVE_COPY.search} aria-label={RECEIVE_COPY.search} value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
            {vaultSide && <p className="rcv-identity">{VAULT_DEPOSIT_NOTE}</p>}
            {groups.length ? (
              <div className="rcv-groups">
                {groups.map(group => {
                  const current = !vaultSide && group.chain === network;
                  const missing = group.rows.some(entry => !entry.unavailable && !addressOf(entry));
                  return (
                    <section
                      key={group.chain}
                      className="rcv-group"
                      data-current={current || undefined}
                      aria-labelledby={`rcv-group-${group.chain}`}
                      ref={element => { if (element) groupRefs.current.set(group.chain, element); else groupRefs.current.delete(group.chain); }}
                    >
                      <h3 className="ui-eyebrow rcv-group-title" id={`rcv-group-${group.chain}`}>
                        {group.name}{current && <span className="rcv-current"> · Selected</span>}
                      </h3>
                      {missing && <p className="rcv-group-note">{group.chain === 'solana' ? RECEIVE_COPY.noSolana : RECEIVE_COPY.noEvm}</p>}
                      <ul className="ui-card rcv-list">
                        {group.rows.map(entry => {
                          const usable = !!addressOf(entry);
                          return (
                            <li key={entry.key} className="rcv-row" data-asset-row="receive" data-chain={entry.chain} data-row-key={entry.key} data-disabled={!usable || undefined}>
                              <span className="rcv-logo" aria-hidden="true"><TokenLogo symbol={entry.mark} /></span>
                              <span className="rcv-main">
                                <span className="rcv-label">{entry.label}</span>
                                <span className="rcv-sub">{entry.name}</span>
                              </span>
                              {usable ? (
                                <span className="rcv-actions">
                                  <button type="button" className="ui-icon-btn" aria-label={`Show QR code for ${entry.label} on ${entry.network}`} onClick={() => { lastRow.current = entry.key; setSelected(entry.key); }}><Icon name="qr" /></button>
                                  <button type="button" className="ui-icon-btn" aria-label={`Copy ${vaultSide ? 'vault deposit' : entry.network} address for ${entry.label}`} onClick={() => void copy(entry)}><Icon name="copy" /></button>
                                </span>
                              ) : entry.unavailable ? <span className="rcv-note">{entry.unavailable}</span> : null}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            ) : (
              <p className="rcv-empty">{RECEIVE_COPY.noMatch}</p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

function SideTag({ vault }: { vault: boolean }) {
  return (
    <p className="rcv-side" data-side={vault ? 'vault' : 'wallet'}>
      <Icon name={vault ? 'vault' : 'portfolio'} size={15} />
      {vault ? RECEIVE_COPY.toVault : RECEIVE_COPY.toWallet}
    </p>
  );
}
