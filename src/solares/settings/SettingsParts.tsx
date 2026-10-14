// Building blocks of the Settings screen (docs/UI_ARGUS_PARITY.md 6.16): an ARGUS-style
// section (small label above one card), a row (title, one line, one control) and the
// preference switch. Area E.
import { forwardRef, type ReactNode } from 'react';
import './settings.css';

/** `focusTarget` lets a deep link (#addressbook) move focus to the section. */
export const SettingsSection = forwardRef<HTMLElement, { id: string; title: string; children: ReactNode; className?: string; focusTarget?: boolean }>(
  function SettingsSection({ id, title, children, className, focusTarget = false }, ref) {
    return (
      <section ref={ref} className={`set-section${className ? ` ${className}` : ''}`} aria-labelledby={id} tabIndex={focusTarget ? -1 : undefined}>
        <h2 id={id} className="set-section-title ui-eyebrow">{title}</h2>
        <div className="set-card ui-card">{children}</div>
      </section>
    );
  },
);

export function SettingsRow({ title, description, children, extra }: { title: string; description?: ReactNode; children?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
        {extra}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}

/** An on/off preference. The accessible name is fixed by the caller ("Celestial motion", …). */
export function SettingsSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" className="set-switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span className="set-switch-track" aria-hidden="true"><span className="set-switch-knob" /></span>
    </button>
  );
}
