// EmptyState (docs/UI_ARGUS_PARITY.md 4.4): optional art from ANTARA's own media (4.5),
// a title, one sentence and at most one action.
import type { ReactNode } from 'react';
import { MEDIA, type MediaName } from './media';
import './ui.css';

export function EmptyState({ art, title, text, action, className }: {
  /** One of the 4.5 media; decorative (empty alt). */
  art?: MediaName;
  title: string;
  /** One sentence. */
  text: string;
  /** One action: a button, usually `.ui-btn-primary` or `.ui-btn`. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-empty${className ? ` ${className}` : ''}`}>
      {art && <img className="ui-empty-art" src={MEDIA[art]} alt="" loading="lazy" decoding="async" />}
      <h3 className="ui-empty-title">{title}</h3>
      <p className="ui-empty-text">{text}</p>
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
