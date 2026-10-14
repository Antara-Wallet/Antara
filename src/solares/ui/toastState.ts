/** Pure toast state behind Toast and ToastProvider (docs/UI_ARGUS_PARITY.md 4.4, 6.17). */

/** Existing behaviour: a toast stays 4.5 seconds unless dismissed. */
export const TOAST_DURATION_MS = 4_500;

/** One toast at a time; a new message replaces the current one. `id` restarts the timer even for a repeated message. */
export interface ToastState {
  id: number;
  message: string;
}

export type ToastAction = { type: 'show'; message: string } | { type: 'dismiss'; id?: number };

export function toastReducer(state: ToastState | null, action: ToastAction): ToastState | null {
  if (action.type === 'show') {
    const message = action.message.trim();
    return message ? { id: (state?.id ?? 0) + 1, message } : state;
  }
  // A late timer for a replaced toast must not dismiss its successor.
  if (action.id !== undefined && state && action.id !== state.id) return state;
  return null;
}
