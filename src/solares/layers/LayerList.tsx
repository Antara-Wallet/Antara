// The protection list (owner feedback 2026-10-13): one compact row per layer with its icon, name, a status
// pill, one short line and at most one action. Presentation only: rows come from rows.ts. A row without an
// action says why in one muted line; there is never a disabled button.
import { LayerIcon } from '../verification/layerIcons';
import type { LayerRowModel } from './rows';
import './layers.css';

export function LayerList({ rows, onOpen, label = 'Your protection layers' }: { rows: readonly LayerRowModel[]; onOpen?: (row: LayerRowModel) => void; label?: string }) {
  return <ul className="vl-list" aria-label={label}>
    {rows.map(row => <li key={row.id} className="vl-row" data-layer={row.id} data-tone={row.pill?.tone ?? 'unknown'}>
      <span className="vl-row-icon" aria-hidden="true"><LayerIcon id={row.id} size={18} /></span>
      <span className="vl-row-text">
        <span className="vl-row-title">
          <span className="vl-row-name">{row.name}</span>
          {row.pill && <span className="vl-pill" data-tone={row.pill.tone}>{row.pill.label}</span>}
        </span>
        <span className="vl-row-line">{row.line}</span>
        {row.note && <span className="vl-row-note">{row.note}</span>}
      </span>
      {row.action && onOpen && <button type="button" className="vl-row-btn" data-kind={row.action.kind} aria-label={`${row.action.label}: ${row.name}`} onClick={() => onOpen(row)}>{row.action.label}</button>}
    </li>)}
  </ul>;
}

export default LayerList;
