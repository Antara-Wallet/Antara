/**
 * What a vault's protection layers allow on this screen. Pure, so the rules are tested
 * without React. The server decides every release; this only stops the wallet from
 * proposing (and paying for) a release or a deposit the vault is not ready for:
 * - Layers that could not be read pause deposits and releases here. They are never
 *   read as "no layers".
 * - A passkey is required to finish activating a vault and for every release (owner
 *   decision), so a vault without an enrolled passkey takes no deposit or release here.
 */
import { LAYER_NAMES, SURFACE_NOTES } from './claims';
import type { LayerView, PendingChangeNotice, VaultLayersView } from './types';

export type VaultLayersLoad =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `pending`: changes still readable from a 200 the strict parser refused (never a layer status). */
  | { status: 'unavailable'; code: string; message: string; pending?: PendingChangeNotice[] }
  | { status: 'ready'; view: VaultLayersView; refreshing: boolean };

/** Pending loosening or recovery changes to warn about, from a valid view or from a view that could not be shown. */
export function pendingNotices(load: VaultLayersLoad): PendingChangeNotice[] {
  if (load.status === 'ready') return load.view.pending;
  return load.status === 'unavailable' ? load.pending ?? [] : [];
}

/**
 * The warning for one pending change (PendingChangeAlert), from fixed text only. The change's summary can quote
 * a label whoever holds the session chose, so it stays in the Pending changes list and never in this warning.
 */
export function pendingSentence(change: PendingChangeNotice): string {
  const kind = change.class === 'recovery'
    ? `recovery${change.waived?.length ? `: waives ${change.waived.map(id => LAYER_NAMES[id]).join(', ')}` : ''}`
    : 'loosens a layer you have on';
  return `A change that weakens this vault’s protection takes effect on ${new Date(change.effectiveAt).toLocaleString()} (${kind}).`;
}

export interface LayerGate {
  /** 'activate-passkey' while the vault still needs its first passkey. */
  stage: 'checking' | 'unavailable' | 'activate-passkey' | 'ready';
  /** Why releases cannot be started here, or ''. */
  releaseBlock: string;
  /** Why deposits cannot be made here, or ''. */
  depositBlock: string;
  /**
   * While no passkey is in force: when the vault's first passkey is pending (a recovery change, because it was not
   * added from the activating app within its window), the time it takes effect. Null otherwise.
   */
  firstPasskeyAt: number | null;
}

export const layerById = (view: VaultLayersView, id: LayerView['id']) => view.layers.find(layer => layer.id === id)!;

/** An enrolled passkey that is in force now (a pending addition does not count). */
export function passkeyEnrolled(view: VaultLayersView): boolean {
  const biometrics = layerById(view, 'biometrics');
  return biometrics.status !== 'not-enrolled' && biometrics.items.some(item => item.type === 'passkey' && item.state !== 'pending-addition');
}

/** The earliest pending passkey addition, when no passkey is in force yet (a first passkey added as a 7-day recovery change). */
export function pendingFirstPasskeyAt(view: VaultLayersView): number | null {
  if (passkeyEnrolled(view)) return null;
  const times = layerById(view, 'biometrics').items.filter(item => item.type === 'passkey' && item.state === 'pending-addition' && item.effectiveAt !== null).map(item => item.effectiveAt!);
  return times.length ? Math.min(...times) : null;
}

export function layerGate(load: VaultLayersLoad): LayerGate {
  if (load.status === 'idle' || load.status === 'loading') {
    const wait = 'Checking your vault’s protection layers.';
    return { stage: 'checking', releaseBlock: wait, depositBlock: wait, firstPasskeyAt: null };
  }
  if (load.status === 'unavailable') {
    const paused = `Your vault’s protection layers could not be checked, so deposits and releases are paused here. ${load.message}`.trim();
    return { stage: 'unavailable', releaseBlock: paused, depositBlock: paused, firstPasskeyAt: null };
  }
  if (!passkeyEnrolled(load.view)) {
    const firstPasskeyAt = pendingFirstPasskeyAt(load.view);
    if (firstPasskeyAt !== null) {
      // Pending is not in force: deposits and releases stay paused until it takes effect (or another passkey applies).
      const when = new Date(firstPasskeyAt).toLocaleString();
      return {
        stage: 'activate-passkey', firstPasskeyAt,
        releaseBlock: `Releases are paused until this vault’s first passkey takes effect on ${when}. ${SURFACE_NOTES.passkeyFirstPending}`,
        depositBlock: `Deposits are paused until this vault’s first passkey takes effect on ${when}. ${SURFACE_NOTES.passkeyFirstPending}`,
      };
    }
    return { stage: 'activate-passkey', firstPasskeyAt: null, releaseBlock: `Releases are paused: add a passkey to finish activating this vault. ${SURFACE_NOTES.passkeyRequired}`, depositBlock: `Add a passkey to finish activating this vault before depositing. ${SURFACE_NOTES.passkeyRequired}` };
  }
  return { stage: 'ready', releaseBlock: '', depositBlock: '', firstPasskeyAt: null };
}
