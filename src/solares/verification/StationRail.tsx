// Station rail (docs/UI_ARGUS_PARITY.md 7.1, 7.3): the landing's leader-line labels around
// the vault planet on wide screens. Each item sits at its station's projected position
// (AntaraSculpture's onNodePositions) and shows the layer icon, name and status label.
// Same list semantics as StationChips: "<Layer>: <label>", data-station-state per item.
import type { CSSProperties } from 'react';
import type { NodePosition } from '../landing/AntaraSculpture';
import { LAYER_NAMES } from '../layers/claims';
import type { LayerId } from '../layers/types';
import { LayerIcon } from './layerIcons';
import type { StationItem } from './StationChips';
import '../ui/ui.css';
import './verification.css';

export function StationRail({ states, positions, onSelect, label = 'Protection layers' }: {
  states: readonly StationItem[];
  /** Station positions relative to the planet canvas (0-1), landing order. */
  positions: readonly NodePosition[];
  onSelect?: (id: LayerId) => void;
  label?: string;
}) {
  return (
    <ul className="vseq-rail" aria-label={label}>
      {states.map((item, index) => {
        const point = positions[index] ?? { x: .5, y: .5, visible: true };
        const side = point.x < .5 ? 'left' : 'right';
        const content = <>
          <span className="vseq-rail-line" aria-hidden="true" />
          <span className="vseq-rail-icon"><LayerIcon id={item.id} size={19} /></span>
          <span className="vseq-rail-text">
            <span className="vseq-rail-name">{LAYER_NAMES[item.id]}</span>
            {item.label && <><span className="ui-visually-hidden">: </span><span className="vseq-rail-status" title={item.label}>{item.label}</span></>}
          </span>
        </>;
        return (
          <li key={item.id} className="vseq-rail-item" data-station-state={item.visual} data-station={item.id} data-side={side}
            style={{ '--node-x': `${point.x * 100}%`, '--node-y': `${point.y * 100}%` } as CSSProperties}>
            {onSelect
              ? <button type="button" className="vseq-rail-node" onClick={() => onSelect(item.id)}>{content}</button>
              : <span className="vseq-rail-node">{content}</span>}
          </li>
        );
      })}
    </ul>
  );
}
