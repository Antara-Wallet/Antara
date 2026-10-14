// Stepper (docs/UI_ARGUS_PARITY.md 4.4): numbered steps for Send (1 Asset · 2 Details ·
// 3 Review · 4 Result), Activation and Verification. The current step carries
// aria-current="step"; completed steps say so in text, not only in colour.
import { stepItems, stepSummary } from './steps';
import './ui.css';

export function Stepper({ steps, current, label, className }: {
  steps: readonly string[];
  /** 0-based index of the active step; `steps.length` when every step is done. */
  current: number;
  /** Accessible name. Default "1 Asset · 2 Details · …". */
  label?: string;
  className?: string;
}) {
  return (
    <ol className={`ui-stepper${className ? ` ${className}` : ''}`} aria-label={label ?? stepSummary(steps)}>
      {stepItems(steps, current).map(item => (
        <li key={item.number} className="ui-step" data-status={item.status} aria-current={item.status === 'current' ? 'step' : undefined}>
          <span className="ui-step-label">
            <span className="ui-step-number">{item.number}</span>
            <span className="ui-step-text">{item.label}</span>
            {item.status === 'complete' && <span className="ui-visually-hidden"> (done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
