// Presentation pieces of the Vault screen (WalletVault / PairedSolanaVault): the balance card
// with its actions inside, the "Create your vault" hero, the state card, the protection card and
// the layer preview. Props in, markup out: every value is derived by the containers from the
// chain, the ANTARA API and GET /solana/layers. Nothing here claims a state on its own.
//
// Balances follow the owner rules (2026-10-13): the headline is the vault's total in US dollars
// ("≈ $8.43", vaults/vaultValue.ts) over what it holds ("0.005 SOL · 0 USDC"); a balance that is
// not known renders as a muted "0.00" with the reason as its accessible name and a visible
// caption, never "—"; a failed load adds "Couldn't load · Retry".
import type { ReactNode } from 'react';
import { TokenLogo } from '../TokenLogo';
import { LAYER_NAMES } from '../layers/claims';
import type { LayerId } from '../layers/types';
import { ROW_ORDER } from '../layers/rows';
import type { VaultLayersLoad } from '../layers/gate';
import { Icon, StatusChip, type ChipTone, type IconName } from '../ui';
import { LoadFailed, PlaceholderAmount } from '../wallet/BalancePlaceholder';
import { VaultLayerChips } from '../verification/StationChips';
import { LayerIcon } from '../verification/layerIcons';
import { LAYER_LINES } from '../verification/layerLines';
import './vaults.css';

export type VaultCardValue =
  /** The vault's total in US dollars: "$8.43" with `approx` (rendered "≈ $8.43"), or an exact "$0.00". */
  | { kind: 'usd'; amount: string; approx: boolean; title?: string }
  /** A token amount: the largest holding when no held asset has a price. */
  | { kind: 'amount'; amount: string; unit: string }
  | { kind: 'masked' }
  /** Not known (signed out, loading, no vault, failed): a muted 0.00, `reason` read by screen readers. */
  | { kind: 'placeholder'; unit: string; reason: string };

export interface VaultBalanceCardProps {
  /** "Vault · total". */
  label: string;
  value: VaultCardValue;
  /** What the vault holds, e.g. ["0.005 SOL", "0 USDC"]. */
  breakdown?: readonly string[];
  /** The caption under the balance. */
  meta: string;
  /** The vault could not be read: adds "Couldn't load · Retry". */
  failed?: boolean;
  onRetry?: () => void;
  privacy: boolean;
  onPrivacy: () => void;
  settingsOpen: boolean;
  onSettings: () => void;
  network: { name: string; logo: string };
  /** The line under the balance: the vault or wallet address it belongs to. */
  foot?: ReactNode;
  /** No vault yet: a shorter card. */
  compact?: boolean;
  /** The action row, inside the card. */
  children?: ReactNode;
}

export function VaultBalanceCard({ label, value, breakdown = [], meta, failed, onRetry, privacy, onPrivacy, settingsOpen, onSettings, network, foot, compact, children }: VaultBalanceCardProps) {
  return (
    <section className="vx-card ui-card" data-compact={compact || undefined} data-value={value.kind} aria-label="Vault balance">
      <div className="vx-card-art" aria-hidden="true" />
      <div className="vx-card-top">
        <span className="vx-card-label ui-eyebrow">{label}</span>
        <div className="vx-card-tools">
          <span className="vx-network"><TokenLogo symbol={network.logo} />{network.name}</span>
          <button type="button" className="ui-icon-btn vx-icon-btn" aria-label="Vault settings" title="Vault settings" aria-expanded={settingsOpen} onClick={onSettings}>
            <Icon name="settings" size={18} />
          </button>
        </div>
      </div>
      <div className="vx-card-body">
        <div className="vx-card-value">
          <h2 className="vx-balance desktop-balance-number" data-state={value.kind}
            aria-label={value.kind === 'placeholder' ? value.reason : undefined} title={value.kind === 'placeholder' ? value.reason : value.kind === 'usd' ? value.title : undefined}>
            {value.kind === 'masked' ? '••••••'
              : value.kind === 'usd' ? <>{value.approx && <span className="vx-approx">≈ </span>}{value.amount}</>
              : value.kind === 'amount' ? <>{value.amount}<small>{value.unit}</small></>
              : <PlaceholderAmount />}
          </h2>
          <button type="button" className="ui-icon-btn vx-icon-btn" onClick={onPrivacy} aria-label={privacy ? 'Show balances' : 'Hide balances'} title={privacy ? 'Show balances' : 'Hide balances'}>
            <Icon name={privacy ? 'hidden' : 'eye'} size={18} />
          </button>
        </div>
        {breakdown.length > 0 && <p className="vx-breakdown" aria-label="Vault holdings">{breakdown.map(item => <span key={item}>{item}</span>)}</p>}
        <p className="vx-meta">{meta}</p>
        {failed && <LoadFailed className="vx-load-failed" onRetry={onRetry} retryLabel="Retry loading your vault" />}
      </div>
      {foot && <div className="vx-card-foot">{foot}</div>}
      {children}
    </section>
  );
}

export interface VaultAction {
  label: string;
  icon: IconName;
  onClick?: () => void;
  /** Why it cannot be used now, or ''. A disabled action always says why. */
  reason?: string;
  primary?: boolean;
}

/** The vault's actions, inside the balance card (owner decision: never a floating row under it). */
export function VaultActionRow({ actions, note, label = 'Vault actions' }: { actions: readonly VaultAction[]; note?: string; label?: string }) {
  return (
    <div className="vx-actions-wrap">
      <div className="vx-actions" role="group" aria-label={label}>
        {actions.map(action => {
          const disabled = !action.onClick || !!action.reason;
          return (
            <button key={action.label} type="button" className={`vx-action${action.primary ? ' is-primary' : ''}`} disabled={disabled}
              title={disabled && action.reason ? action.reason : undefined} aria-describedby={disabled && note ? 'vx-actions-note' : undefined}
              onClick={() => action.onClick?.()}>
              <span className="vx-action-icon" aria-hidden="true"><Icon name={action.icon} size={18} /></span>
              <span className="vx-action-label">{action.label}</span>
            </button>
          );
        })}
      </div>
      {note && <p className="vx-actions-note" id="vx-actions-note" role="note">{note}</p>}
    </div>
  );
}

export type FundingView =
  | { state: 'checking' }
  /** The live cost is known. `have` is the wallet's SOL when known. */
  | { state: 'met' | 'short' | 'unknown'; cost: string; detail: string | null; have: string | null };

export interface CreateVaultHeroProps {
  /** A creation was started on this device and not registered. */
  pending: string | null;
  funding: FundingView;
  busy: boolean;
  onCreate: () => void;
  onFinish: () => void;
  /** Offered only while Solana reports no account at `pending` (the creation never landed); absent otherwise. */
  onDiscard?: () => void;
  /** Why the attempt cannot be discarded, shown when `onDiscard` is absent. */
  discardNote?: string;
  /** Receive SOL into the wallet (the wallet side of Receive). */
  onAddSol: () => void;
  onCheckAgain: () => void;
  onHowItWorks: () => void;
}

const STEPS: readonly { title: string; text: string }[] = [
  { title: 'Create vault', text: 'Your wallet signs one Solana transaction that creates the vault.' },
  { title: 'Add a passkey', text: 'Required. Your device signs every release with it.' },
  { title: 'Choose your layers', text: 'Safe zones, networks, Bluetooth, an authenticator app and your own caps, all optional.' },
];

/** No vault yet: what it is, the three steps, what it costs, and the one obvious way to create it. */
export function CreateVaultHero({ pending, funding, busy, onCreate, onFinish, onDiscard, discardNote, onAddSol, onCheckAgain, onHowItWorks }: CreateVaultHeroProps) {
  const short = funding.state === 'short';
  const fundingTone: ChipTone = funding.state === 'met' ? 'ok' : short ? 'warn' : 'neutral';
  const fundingChip = funding.state === 'checking' ? 'Checking' : funding.have !== null ? `You have ${funding.have} SOL` : 'Balance unavailable';
  const pendingShort = pending ? `${pending.slice(0, 6)}…${pending.slice(-5)}` : '';
  return (
    <section className="vx-create ui-card" aria-labelledby="vx-create-title" data-funding={funding.state}>
      <div className="vx-create-art" aria-hidden="true" />
      <div className="vx-create-copy">
        <p className="ui-eyebrow vx-eyebrow">Solana vault · 2 of 2</p>
        <h2 id="vx-create-title">{pending ? 'Finish creating your vault' : 'Create your vault'}</h2>
        <p className="vx-lead">{pending
          ? `A vault creation for this wallet (${pendingShort}) was started but not registered. Finish activation to verify it on-chain and register it.`
          : 'A 2-of-2 vault beside your wallet. Every release needs your wallet and ANTARA’s guardian, which approves only after the protection layers you choose pass.'}</p>
      </div>

      <ol className="vx-steps" aria-label="How your vault is set up">
        {STEPS.map((step, index) => (
          <li key={step.title} data-current={index === 0 || undefined}>
            <span className="vx-step-number" aria-hidden="true">{index + 1}</span>
            <span className="vx-step-text"><strong>{step.title}</strong><span>{step.text}</span></span>
          </li>
        ))}
      </ol>

      {!pending && (
        <div className="vx-need" data-state={funding.state} role={short ? 'alert' : undefined}>
          <span className="vx-need-icon" aria-hidden="true"><TokenLogo symbol="solana" /></span>
          <span className="vx-need-text">
            <strong>{funding.state === 'checking' ? 'Checking what creating a vault costs…'
              : short ? 'Add SOL to create your vault'
              : `Needs ${funding.cost} in your wallet`}</strong>
            <span>{funding.state === 'checking' ? 'Reading the vault account rent and the Squads fee from Solana.'
              : short ? `Creating a vault needs ${funding.cost} in your Solana wallet for the vault’s account rent and the network fee.`
              : funding.detail ?? 'For the vault’s account rent and the network fee. Your wallet shows the exact amount before you sign.'}</span>
          </span>
          <StatusChip tone={fundingTone} label={fundingChip} className="vx-need-chip" />
        </div>
      )}

      <div className="vx-create-actions">
        {pending ? <>
          <button type="button" className="ui-btn-primary vx-cta" disabled={busy} onClick={onFinish}>Finish activation</button>
          {onDiscard && <button type="button" className="ui-btn" disabled={busy} onClick={onDiscard} title="Only if the creation transaction never confirmed">Discard this attempt</button>}
        </> : short ? <>
          <button type="button" className="ui-btn-primary vx-cta" onClick={onAddSol}><Icon name="down" size={17} />Receive SOL</button>
          <button type="button" className="ui-btn" onClick={onCheckAgain}>Check again</button>
        </> : <>
          <button type="button" className="ui-btn-primary vx-cta" disabled={busy || funding.state === 'checking'} onClick={onCreate}><Icon name="plus" size={17} />Create vault</button>
          <button type="button" className="ui-btn-text vx-how" onClick={onHowItWorks}>How releases are approved</button>
        </>}
      </div>
      {pending && !onDiscard && discardNote && <p className="vx-fine" role="note">{discardNote}</p>}
    </section>
  );
}

export interface StateCardProps {
  title: string;
  text: string;
  tone?: 'neutral' | 'warn' | 'danger';
  icon?: IconName;
  /** Busy (loading): a quiet card without actions. */
  loading?: boolean;
  children?: ReactNode;
}

/** One state of the vault that needs a sentence and, at most, two actions. Titles are the existing ones (6.6). */
export function VaultStateCard({ title, text, tone = 'neutral', icon = 'shield', loading, children }: StateCardProps) {
  return (
    <section className="vx-state ui-card" data-tone={tone} aria-labelledby="vx-state-title" aria-busy={loading || undefined}>
      <span className="vx-state-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
      <div className="vx-state-copy">
        <h2 id="vx-state-title">{title}</h2>
        {text && <p>{text}</p>}
        {children && <div className="vx-state-actions">{children}</div>}
      </div>
    </section>
  );
}

/** The vault's six layers as chips from GET /solana/layers, with the way into managing them. */
export function VaultProtectionCard({ layers, onSelect, onManage, summary }: { layers: VaultLayersLoad; onSelect: (id?: LayerId) => void; onManage: () => void; summary: string }) {
  return (
    <section className="vx-protection ui-card" aria-label="Vault protection">
      <header className="vx-section-head">
        <div><h3>Protection layers</h3><p>{summary}</p></div>
        <button type="button" className="ui-btn vx-small-btn" onClick={onManage}>Manage layers</button>
      </header>
      <VaultLayerChips layers={layers} onSelect={id => onSelect(id)} compact />
    </section>
  );
}

/** Before a vault exists: the six layers it can have, described only (no status, nothing "on"). */
export function VaultLayersPreview({ note }: { note: string }) {
  return (
    <section className="vx-preview ui-card" aria-labelledby="vx-preview-title">
      <header className="vx-section-head">
        <div><h3 id="vx-preview-title">Layers you can add</h3><p>{note}</p></div>
      </header>
      <ul className="vx-preview-list">
        {ROW_ORDER.map(id => (
          <li key={id}>
            <span className="vx-layer-icon" aria-hidden="true"><LayerIcon id={id} size={17} /></span>
            <span className="vx-preview-text"><strong>{LAYER_NAMES[id]}</strong><span>{LAYER_LINES[id]}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "How releases are approved": the fixed claims (layers/claims.ts), verbatim. */
export function VaultClaimsCard({ claims, id }: { claims: readonly string[]; id?: string }) {
  return (
    <section className="vx-claims ui-card" aria-labelledby={id ?? 'vx-claims-title'} id={id ? `${id}-section` : undefined}>
      <header className="vx-section-head"><div><h3 id={id ?? 'vx-claims-title'}>How releases are approved</h3></div></header>
      <ul className="vx-claims-list pv-claims">{claims.map(claim => <li key={claim}><Icon name="check" size={14} />{claim}</li>)}</ul>
    </section>
  );
}
