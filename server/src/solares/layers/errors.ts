import type { LayerId, LayerRequirement } from './types.js';

export type LayerErrorCode = 'layers-required' | 'layer-failed' | 'challenge-invalid' | 'challenge-stale' | 'locked';
/** Per-layer outcome. `reason` is ANTARA's own text and never contains a stored or reported value. */
export interface LayerResult { id: LayerId; ok: boolean; reason?: string }
export interface LayerErrorExtra { required?: LayerRequirement[]; layers?: LayerResult[] }

/**
 * A layer refusal with one of the codes in docs/VAULT_LAYERS.md §9. The route
 * copies only `extra.required` (layers-required) or `extra.layers`
 * (layer-failed) into the JSON answer. Every other refusal is a GuardianError.
 */
export class LayerError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 429,
    readonly code: LayerErrorCode,
    readonly extra: LayerErrorExtra = {},
    /** 429 `locked` only: seconds until the lock ends. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message); this.name = 'LayerError';
  }
}

export const LAYER_MESSAGES = Object.freeze({
  required: 'This vault has protection layers on. Verify them to approve this release.',
  failed: 'A protection layer did not pass. Nothing was approved.',
  changeFailed: 'A protection layer did not pass. Nothing was changed.',
  invalid: 'This verification request is invalid or expired. Start again.',
  stale: 'The vault or its protection layers changed after verification started. Start again.',
  locked: 'Too many failed protection checks for this vault. Try again later.',
});
