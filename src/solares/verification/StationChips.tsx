// Station chips (docs/UI_ARGUS_PARITY.md 6.6, 7.1, 7.3): the six protection layers as a 3×2
// grid, in landing order, each with its icon, name and the server-derived status label. Used on
// narrow screens under the planet, beside the vault balance, and whenever WebGL is unavailable.
// The list is the source of truth for assistive technology ("<Layer>: <label>"); each item
// carries data-station-state for tests. No aria-live here: the sequence's status line
// announces changes once.
import { LAYER_NAMES } from '../layers/claims';
import type { LayerId } from '../layers/types';
import { LayerIcon } from './layerIcons';
import type { VaultLayersLoad } from '../layers/gate';
import { overviewStations, type StationVisual } from './stationState';
import '../ui/ui.css';
import './verification.css';

export interface StationItem { id: LayerId; visual: StationVisual; label: string }

/**
 * The Vault side's chips (6.6): rendered only when GET /solana/layers answered for this vault;
 * otherwise one line, and no "On" or "Off" anywhere.
 */
export function VaultLayerChips({ layers, onSelect, compact = false }: { layers: VaultLayersLoad; onSelect?: (id: LayerId) => void; compact?: boolean }) {
  if (layers.status !== 'ready') {
    return <p className="vseq-chips-note" role="status">{layers.status === 'unavailable' ? 'Protection status unavailable' : 'Checking protection…'}</p>;
  }
  return <StationChips states={overviewStations(layers)} onSelect={onSelect} compact={compact} />;
}

export function StationChips({ states, onSelect, label = 'Protection layers', compact = false, className }: {
  states: readonly StationItem[];
  /** Opens Vault protection layers at that layer. Without it the chips are plain items. */
  onSelect?: (id: LayerId) => void;
  label?: string;
  /** One row of six (the Vault side on desktop) instead of 3×2. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <ul className={`vseq-chips${compact ? ' vseq-chips-row' : ''}${className ? ` ${className}` : ''}`} aria-label={label}>
      {states.map(item => {
        const content = <>
          <span className="vseq-chip-icon"><LayerIcon id={item.id} size={18} /></span>
          <span className="vseq-chip-text">
            <span className="vseq-chip-name">{LAYER_NAMES[item.id]}</span>
            {item.label && <><span className="ui-visually-hidden">: </span><span className="vseq-chip-status" title={item.label}>{item.label}</span></>}
          </span>
        </>;
        return (
          <li key={item.id} className="vseq-chip-item" data-station-state={item.visual} data-station={item.id}>
            {onSelect
              ? <button type="button" className="vseq-chip" onClick={() => onSelect(item.id)}>{content}</button>
              : <span className="vseq-chip">{content}</span>}
          </li>
        );
      })}
    </ul>
  );
}
