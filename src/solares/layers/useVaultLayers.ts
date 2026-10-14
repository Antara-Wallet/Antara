import { useCallback, useEffect, useRef, useState } from 'react';
import { PairedVaultApiError } from '../vaults/pairedApi';
import { LayerViewError, fetchVaultLayers } from './api';
import type { VaultLayersLoad } from './gate';

/** Why layers cannot be shown. Never a layer status. */
export function layersUnavailableMessage(failure: unknown): { code: string; message: string } {
  if (failure instanceof PairedVaultApiError) {
    if (failure.code === 'not-provisioned') return { code: failure.code, message: 'ANTARA’s vault guardian is not switched on for this server, so protection layers cannot be shown.' };
    if (failure.code === 'locked') {
      const minutes = failure.retryAfterSeconds ? Math.max(1, Math.ceil(failure.retryAfterSeconds / 60)) : 15;
      return { code: failure.code, message: `Too many checks failed, so ANTARA has paused layer checks for this vault. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` };
    }
    return { code: failure.code, message: `Protection layers cannot be shown right now. ${failure.message}`.trim() };
  }
  return { code: 'unavailable', message: `Protection layers cannot be shown right now. ${failure instanceof Error && failure.message ? failure.message : ''}`.trim() };
}

/**
 * GET /solana/layers for one vault. A refresh keeps the last answer on screen until the
 * new one arrives; a failed refresh replaces it, so a stale status is never kept.
 * `multisig` null means there is no verified vault, and nothing is fetched.
 */
export function useVaultLayers(multisig: string | null, getToken: () => Promise<string>): { load: VaultLayersLoad; reload: () => void } {
  const [load, setLoad] = useState<VaultLayersLoad>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!multisig) { shown.current = null; setLoad({ status: 'idle' }); return; }
    const controller = new AbortController();
    // A different vault never inherits the previous vault's answer.
    setLoad(current => current.status === 'ready' && shown.current === multisig ? { ...current, refreshing: true } : { status: 'loading' });
    void (async () => {
      try {
        const view = await fetchVaultLayers(await tokenRef.current(), multisig, controller.signal);
        if (controller.signal.aborted) return;
        shown.current = multisig;
        setLoad({ status: 'ready', view, refreshing: false });
      } catch (failure) {
        if (controller.signal.aborted) return;
        shown.current = null;
        setLoad({ status: 'unavailable', ...layersUnavailableMessage(failure), pending: failure instanceof LayerViewError ? failure.pending : [] });
      }
    })();
    return () => controller.abort();
  }, [multisig, attempt]);

  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { load, reload };
}
