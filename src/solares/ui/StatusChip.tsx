// StatusChip (docs/UI_ARGUS_PARITY.md 4.4): neutral, ok (ice), warn, danger. The label is
// required and always rendered, and each tone also has its own mark, so colour is never
// the only signal. A chip states what the caller knows; it never invents a status.
import type { ReactNode } from 'react';
import './ui.css';

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'danger';

const MARKS: Record<ChipTone, ReactNode> = {
  neutral: <circle cx="6" cy="6" r="2.2" fill="currentColor" />,
  ok: <path d="m3 6.2 2 2L9 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  warn: <path d="M6 2.6v4.2M6 9.2v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  danger: <path d="m3.5 3.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
};

export function StatusChip({ tone = 'neutral', label, title, className }: { tone?: ChipTone; label: string; title?: string; className?: string }) {
  return (
    <span className={`ui-chip${className ? ` ${className}` : ''}`} data-tone={tone} title={title}>
      <svg className="ui-chip-mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">{MARKS[tone]}</svg>
      <span className="ui-chip-label">{label}</span>
    </span>
  );
}
