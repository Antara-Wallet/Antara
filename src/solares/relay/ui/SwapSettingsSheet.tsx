// Swap settings (docs/UI_ARGUS_PARITY.md 6.10, ARGUS S15 settings): slippage 0.5% or 1%
// only (the validator refuses anything else) and a pointer to the review for the order
// terms. There is no swap cap to show (owner decision 2026-10-13). No speed, priority, MEV or fee tiers: Relay
// sets the route, so any such setting would be invented.
import { useRef } from 'react';
import { Sheet } from '../../ui';
import { SETTINGS_TERMS_NOTE, SLIPPAGE_OPTIONS } from './swapModel';

export interface SwapSettingsSheetProps {
  slippage: number;
  onSlippage: (bps: number) => void;
  onClose: () => void;
}

export function SwapSettingsSheet({ slippage, onSlippage, onClose }: SwapSettingsSheetProps) {
  const selected = useRef<HTMLInputElement>(null);
  return (
    <Sheet
      title="Swap settings"
      closeLabel="Close swap settings"
      onClose={onClose}
      initialFocus={selected}
      className="swap-sheet swap-settings"
      footer={<button type="button" className="ui-btn-primary swap-sheet-done" onClick={onClose}>Done</button>}
    >
      <fieldset className="swap-slippage">
        <legend>Slippage tolerance</legend>
        <p className="swap-settings-hint">How far below the quoted amount the order may fill. The review shows the minimum.</p>
        <div className="swap-segments">
          {SLIPPAGE_OPTIONS.map(option => (
            <label key={option.bps} className="swap-segment" data-selected={slippage === option.bps || undefined}>
              <input
                ref={slippage === option.bps ? selected : undefined}
                type="radio"
                name="swap-slippage"
                value={option.bps}
                checked={slippage === option.bps}
                onChange={() => onSlippage(option.bps)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="swap-settings-note">{SETTINGS_TERMS_NOTE}</p>
    </Sheet>
  );
}
