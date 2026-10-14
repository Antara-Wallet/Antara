// The one modal primitive (docs/UI_ARGUS_PARITY.md 4.4): a centred dialog up to 520px on
// desktop, a bottom sheet at 640px and below. Replaces the three copies of trap code.
//
// - Rendered into a portal on <body> (class `ui-layer`), so page transforms and the
//   shell's overflow never clip it, and tokens apply outside `.desktop-app`.
// - role="dialog", aria-modal, labelled by its visible title.
// - Focus moves into the sheet on open, Tab and Shift+Tab stay inside, Escape and a
//   backdrop press close it, and focus returns to the trigger (or `returnFocusTo`).
// - While open, everything else on <body> is `inert`; with sheets stacked, only the
//   top one is interactive and answers Escape.
// - `busy` blocks every way of closing (Escape, backdrop, the close button).
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { FOCUSABLE, createModalStack, trapTarget } from './focus';
import './ui.css';

export interface SheetProps {
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Blocks closing (Escape, backdrop, close button) while an operation runs. */
  busy?: boolean;
  /** Optional line under the title; becomes the dialog's description. */
  description?: string;
  /** Accessible name of the close button. Default "Close". Keep asserted names, e.g. "Close transfer". */
  closeLabel?: string;
  /** Element to focus when the sheet closes. Default: whatever had focus when it opened. */
  returnFocusTo?: HTMLElement | null;
  /** Element to focus on open. Default: the sheet itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 'default' 520px, 'large' 760px, 'drawer' a right-anchored 380px drawer on desktop. Narrow is always a bottom sheet. */
  size?: 'default' | 'large' | 'drawer';
  /** Full height at 640px and below (Send steps, Receive step 2, Activation, Verification). */
  fullScreenNarrow?: boolean;
  /** Left of the title, e.g. a Back button. */
  headerStart?: ReactNode;
  /** Pinned below the scrolling body, e.g. the step's actions. */
  footer?: ReactNode;
  className?: string;
}

const stack = createModalStack();
/** Elements this module made inert, so closing restores exactly what it changed. */
const madeInert = new Set<Element>();

function syncInert() {
  const topId = stack.top();
  for (const element of [...madeInert]) { element.removeAttribute('inert'); madeInert.delete(element); }
  if (!topId) return;
  for (const element of document.body.children) {
    if (element.getAttribute('data-ui-sheet-id') === topId || element.hasAttribute('data-ui-toast') || element.hasAttribute('inert')) continue;
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') continue;
    element.setAttribute('inert', '');
    madeInert.add(element);
  }
}

export function Sheet({
  title, onClose, children, busy = false, description, closeLabel = 'Close', returnFocusTo,
  initialFocus, size = 'default', fullScreenNarrow = false, headerStart, footer, className,
}: SheetProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const sheetRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  // Latest props for the long-lived listeners, without re-running the open/close effect.
  const latest = useRef({ onClose, busy, returnFocusTo });
  latest.current = { onClose, busy, returnFocusTo };
  const container = useRef<HTMLDivElement | null>(null);
  if (!container.current && typeof document !== 'undefined') {
    container.current = document.createElement('div');
    container.current.className = 'ui-layer';
  }

  useEffect(() => {
    const host = container.current!;
    host.setAttribute('data-ui-sheet-id', id);
    host.setAttribute('data-size', size);
    document.body.appendChild(host);
    stack.push(id);
    syncInert();
    (initialFocus?.current ?? sheetRef.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (!stack.isTop(id)) return;
      // Keys typed in another modal over this sheet (Privy's own sign, verify or key export
      // window) belong to that modal: no focus trap and no Escape-to-close from here.
      const origin = event.target;
      if (origin instanceof Element && sheetRef.current && !sheetRef.current.contains(origin) && origin.closest('[role="dialog"], [aria-modal="true"]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const items = [...sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.getClientRects().length > 0);
      const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      (target === -1 ? sheetRef.current : items[target]).focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.remove(id);
      host.remove();
      syncInert();
      const target = latest.current.returnFocusTo ?? opener.current;
      // Under React StrictMode the effect re-runs at once; only a real close returns focus.
      requestAnimationFrame(() => { if (!stack.has(id) && target?.isConnected) target.focus(); });
    };
    // Opening and closing happen once per mount; size changes are applied below.
  }, [id]);
  useEffect(() => { container.current?.setAttribute('data-size', size); }, [size]);

  if (!container.current) return null;
  return createPortal(
    <>
      <div className="ui-backdrop" aria-hidden="true" onMouseDown={() => { if (!busy) onClose(); }} />
      <div
        ref={sheetRef}
        className={`ui-sheet${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        data-size={size}
        data-full-narrow={fullScreenNarrow || undefined}
        tabIndex={-1}
      >
        <header className="ui-sheet-header">
          {headerStart}
          <h2 className="ui-sheet-title" id={titleId}>{title}</h2>
          <button type="button" className="ui-icon-btn" aria-label={closeLabel} disabled={busy} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {description && <p className="ui-sheet-description" id={descriptionId}>{description}</p>}
        <div className="ui-sheet-body">{children}</div>
        {footer && <div className="ui-sheet-footer">{footer}</div>}
      </div>
    </>,
    container.current,
  );
}
