import { pendingSentence } from './gate';
import type { PendingChangeNotice } from './types';
import './layers.css';

/** Scrolls to the vault's Pending changes list and moves focus there (VaultLayers renders it with this id). */
export function revealPendingChanges() {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const target = document.getElementById('vl-pending');
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  });
}

/**
 * Persistent warning while a recovery change is pending (docs/VAULT_LAYERS.md section 8.2; since 2026-10-13 a
 * loosening applies at once, so only a recovery can wait).
 * ANTARA sends no notifications (owner decision O7), so the 7-day wait protects the user only if this is seen.
 * Shown on the vault summary and in the release check, never only inside vault settings.
 */
export function PendingChangeAlert({ pending, onReview }: { pending: PendingChangeNotice[]; onReview?: () => void }) {
  if (!pending.length) return null;
  return <div className="vl-alert vl-pending-alert" role="alert" aria-label="Pending protection change">
    {pending.map(change => <p key={change.id}>{pendingSentence(change)}</p>)}
    <p>If you did not ask for this, cancel it now and secure your ANTARA account.</p>
    {onReview && <button type="button" className="desktop-button" onClick={onReview}>Review or cancel</button>}
  </div>;
}
