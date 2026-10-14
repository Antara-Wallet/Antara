// Toasts (docs/UI_ARGUS_PARITY.md 4.4, 6.17): role="status", 4.5 seconds, dismissible,
// one at a time (a new message replaces the current one), as the shell does today.
//
//   <ToastProvider>…app…</ToastProvider>          mounted once by the shell
//   const toast = useToast(); toast.show('Address copied.');
//   <Toast message={…} onDismiss={…} />            presentational, for a screen that owns its own message
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { TOAST_DURATION_MS, toastReducer } from './toastState';
import './ui.css';

export function Toast({ message, onDismiss, duration = TOAST_DURATION_MS }: { message: string; onDismiss: () => void; duration?: number }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [message, onDismiss, duration]);
  return (
    <div className="ui-toast" role="status">
      <span>{message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

export interface ToastApi {
  /** Shows `message`, replacing any current toast. Empty messages are ignored. */
  show(message: string): void;
  dismiss(): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, dispatch] = useReducer(toastReducer, null);
  const show = useCallback((message: string) => dispatch({ type: 'show', message }), []);
  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), []);
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  const id = toast?.id;
  const dismissCurrent = useCallback(() => dispatch({ type: 'dismiss', id }), [id]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        // data-ui-toast keeps the toast usable while a Sheet makes the rest of the page inert.
        <div className="ui-toast-host" data-ui-toast="">
          {toast && <Toast key={toast.id} message={toast.message} onDismiss={dismissCurrent} />}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/**
 * The shell's toast. Outside a ToastProvider (an isolated harness) it falls back to
 * logging, so a missing provider is visible in the console instead of silently
 * swallowing feedback such as "Address copied.".
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK;
}
const FALLBACK: ToastApi = {
  show: message => console.warn('[ANTARA] Toast without a ToastProvider:', message),
  dismiss: () => undefined,
};
