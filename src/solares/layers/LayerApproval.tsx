import { useState } from 'react';
import { formatAmount } from '../relay/model';
import { PairedVaultApiError, type PairedApproval } from '../vaults/pairedApi';
import { CHECKED_BY, KIND_DESCRIPTIONS, KIND_LABELS, LAYER_NAMES, SURFACE_NOTES, checkedByLines, expectedKinds } from './claims';
import { LayerCollectionError, collectionTitle, type CollectionAction, type LayerPlatform } from './collectors';
import { setupTitle } from './copy';
import { TOTP_CODE, needsTotpCode, submitReleaseApproval, type LayerContext } from './flow';
import { PendingChangeAlert } from './PendingChangeAlert';
import type { LayerId, LayerKind, LayerRequirement, LayerResult, PendingChangeNotice, ReleaseChallenge } from './types';
import './layers.css';

const DECIMALS = { SOL: 9, USDC: 6 } as const;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;

export function KindBadges({ kinds }: { kinds: LayerKind[] }) {
  return <span className="vl-badges">{kinds.map(kind => <span key={kind} className={`vl-badge vl-badge-${kind}`} title={KIND_DESCRIPTIONS[kind]}>{KIND_LABELS[kind]}</span>)}</span>;
}

/** The 6-digit code field for the vault authenticator (MFA layer). The code is single use, so it is cleared after each attempt. */
export function TotpCodeField({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  return <label className="vl-code">
    <span>Code from your vault authenticator app</span>
    <input value={value} disabled={disabled} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" aria-describedby="vl-code-note"
      onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} />
    <small id="vl-code-note" className="vl-note">Each code works once. If it was just used, wait for the next one.</small>
  </label>;
}

/** One row per layer: Wi-Fi's server check and its desktop reading are a single layer. */
export function requirementRows(required: LayerRequirement[]) {
  const rows = new Map<LayerId, { id: LayerId; radio: boolean; evidence: Set<LayerRequirement['evidence']> }>();
  for (const item of required) {
    const row = rows.get(item.id) ?? { id: item.id, radio: false, evidence: new Set() };
    row.evidence.add(item.evidence);
    if (item.reading === 'wifi') row.radio = true;
    rows.set(item.id, row);
  }
  return [...rows.values()];
}

export interface Problem { message: string; action: CollectionAction | null; layer: string | null }
export function problemFrom(failure: unknown, fallback: string): Problem {
  if (failure instanceof LayerCollectionError) return { message: failure.message, action: failure.action, layer: collectionTitle(failure) };
  return { message: failure instanceof Error && failure.message ? failure.message : fallback, action: null, layer: null };
}
export function lockedMessage(failure: PairedVaultApiError) {
  const minutes = failure.retryAfterSeconds ? Math.max(1, Math.ceil(failure.retryAfterSeconds / 60)) : 15;
  return `Too many checks failed, so ANTARA has paused layer checks for this vault. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function ProblemNotice({ problem, platform, onAddDevice, onAddPasskey }: { problem: Problem; platform: LayerPlatform; onAddDevice?: () => void; onAddPasskey?: () => void }) {
  const [opening, setOpening] = useState(false);
  return <div className="vl-alert" role="alert">
    <p>{problem.layer ? <strong>{problem.layer}: </strong> : null}{problem.message}</p>
    {problem.action === 'open-location-settings' && <button type="button" className="ui-btn" disabled={opening} onClick={() => { setOpening(true); void platform.native.openLocationSettings().catch(() => undefined).finally(() => setOpening(false)); }}>Open Windows location settings</button>}
    {problem.action === 'add-device' && onAddDevice && <button type="button" className="ui-btn" onClick={onAddDevice}>{setupTitle(platform.capabilities().surface)}</button>}
    {problem.action === 'add-passkey' && onAddPasskey && <button type="button" className="ui-btn" onClick={onAddPasskey}>Add a passkey</button>}
    {problem.action === 'open-full-tab' && <button type="button" className="ui-btn" onClick={() => void platform.openWalletTab('#vault')}>Open in a full tab</button>}
  </div>;
}

/** Extension side panel: ceremonies run in the full tab, which resumes the saved release with "Continue release". */
export function LayerFullTabHandoff({ platform, onCancel }: { platform: LayerPlatform; onCancel: () => void }) {
  const [problem, setProblem] = useState('');
  return <section className="vl-approval" aria-label="Verify this release">
    <h3>This release needs your protection layers</h3>
    <p>{SURFACE_NOTES.fullTab} Your release is saved; choose “Continue release” there.</p>
    {problem && <div className="vl-alert" role="alert"><p>{problem}</p></div>}
    <div className="vl-actions">
      <button type="button" className="ui-btn-primary" onClick={() => {
        setProblem('');
        void platform.openWalletTab('#vault').then(opened => { if (!opened) setProblem('Open ANTARA in a full tab from the Chrome toolbar, then continue this release.'); })
          .catch(() => setProblem('Chrome did not open a new tab.'));
      }}>Approve in a full tab</button>
      <button type="button" className="ui-btn" onClick={onCancel}>Not now</button>
    </div>
  </section>;
}

export interface LayerApprovalProps {
  challenge: ReleaseChallenge;
  context: LayerContext;
  getToken: () => Promise<string>;
  /** Re-reads the release on this device and begins again. */
  restart: () => Promise<ReleaseChallenge>;
  /** Throws when the wallet session changed since the release started. */
  assertCurrent?: () => void;
  onApproved: (approval: PairedApproval) => void;
  onCancel: () => void;
  onAddDevice?: () => void;
  /** Pending loosening or recovery changes on this vault (from GET /solana/layers), shown before the user verifies. */
  pending?: PendingChangeNotice[];
  onReviewPending?: () => void;
}

/**
 * Section 12 steps 4 to 7: the required layers for this exact release, one "Verify and approve"
 * click (the user gesture Bluetooth needs), then the evidence goes to the guardian.
 */
export function LayerApproval({ challenge: initial, context, getToken, restart, assertCurrent, onApproved, onCancel, onAddDevice, pending = [], onReviewPending }: LayerApprovalProps) {
  const [challenge, setChallenge] = useState(initial);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [failures, setFailures] = useState<LayerResult[] | null>(null);
  // A challenge is single use: once the server has seen it, only a new begin can retry.
  const [spent, setSpent] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const [code, setCode] = useState('');
  const surface = context.platform.capabilities().surface;
  const needsCode = needsTotpCode(challenge);
  const rows = requirementRows(challenge.required);
  const { release } = challenge;

  async function again(note: string) {
    const next = await restart();
    setChallenge(next); setSpent(false); setFailures(null);
    setProblem({ message: note, action: null, layer: null });
  }

  async function verify() {
    if (busy) return;
    setBusy('Verifying your protection layers'); setProblem(null); setFailures(null);
    try {
      if (spent) { await again('Started a new check. Verify again to continue.'); return; }
      assertCurrent?.();
      const approval = await submitReleaseApproval(getToken, challenge, { ...context, onStep: setBusy, totpCode: needsCode ? code : null });
      assertCurrent?.();
      onApproved(approval);
    } catch (failure) {
      if (failure instanceof PairedVaultApiError) {
        setSpent(true);
        if (failure.code === 'layer-failed') {
          setFailures(failure.layers ?? []);
          setProblem({ message: failure.message, action: null, layer: null });
        } else if ((failure.code === 'challenge-stale' || failure.code === 'challenge-invalid') && !restarted) {
          setRestarted(true);
          try { await again('Something changed since this check started (the release, your layers or the time limit). Check the details and verify again.'); }
          catch (restartFailure) { setProblem(problemFrom(restartFailure, 'This release could not be checked again.')); }
        } else setProblem({ message: failure.code === 'locked' ? lockedMessage(failure) : failure.message, action: null, layer: null });
      } else setProblem(problemFrom(failure, 'This release could not be verified. Nothing was approved.'));
    } finally { setBusy(''); setCode(''); }
  }

  const failed = new Map((failures ?? []).filter(item => !item.ok).map(item => [item.id, item.reason]));
  return <section className="vl-approval" aria-label="Verify this release">
    <h3>Verify this release</h3>
    <p className="vl-release">Release #{release.transactionIndex} · {formatAmount(release.amountRaw, DECIMALS[release.asset])} {release.asset} to <code title={release.recipient}>{short(release.recipient)}</code></p>
    <PendingChangeAlert pending={pending} onReview={onReviewPending} />
    <p className="vl-claim">{CHECKED_BY.all}</p>
    <ul className="vl-required" aria-label="Required protection layers">
      {rows.map(row => <li key={row.id} data-layer={row.id} className={failed.has(row.id) ? 'is-failed' : undefined}>
        <div className="vl-row-head"><strong>{LAYER_NAMES[row.id]}</strong><KindBadges kinds={expectedKinds(row.id, row.radio ? 'network+radio' : 'network')} /></div>
        {checkedByLines({ id: row.id, status: 'enrolled', mode: row.radio ? 'network+radio' : 'network' }, surface).map(line => <p key={line} className="vl-claim">{line}</p>)}
        {failed.has(row.id) && <p className="vl-reason">{failed.get(row.id) || 'This layer did not pass.'}</p>}
      </li>)}
    </ul>
    {failures && failed.size === 0 && <div className="vl-alert" role="alert"><p>ANTARA did not approve this release.</p></div>}
    {problem && <ProblemNotice problem={problem} platform={context.platform} onAddDevice={onAddDevice} />}
    {needsCode && !spent && <TotpCodeField value={code} onChange={setCode} disabled={!!busy} />}
    {busy && <p className="vl-busy" role="status">{busy}…</p>}
    <div className="vl-actions">
      <button type="button" className="ui-btn-primary" disabled={!!busy || (needsCode && !spent && !TOTP_CODE.test(code))} onClick={() => void verify()}>{spent ? 'Start again' : 'Verify and approve'}</button>
      <button type="button" className="ui-btn" disabled={!!busy} onClick={onCancel}>Not now</button>
    </div>
    <small className="vl-note">Nothing is sent until every check on this device succeeds. Your release stays saved if you stop here.</small>
  </section>;
}
