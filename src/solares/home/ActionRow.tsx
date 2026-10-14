// The four primary actions of the Wallet side (docs/UI_ARGUS_PARITY.md 6.4): Receive, Send,
// Swap, Vault. They sit inside the balance card (owner decision, 2026-10-13), never as a
// floating row of tiles below it. "Deposit" is reserved for moving funds into the vault
// (U2); each button's accessible name is its visible label.
import type { MouseEvent } from 'react';
import { Icon, type IconName } from '../ui';

export interface ActionRowProps {
  onReceive: (trigger: HTMLButtonElement) => void;
  onSend: (trigger: HTMLButtonElement) => void;
  onSwap: () => void;
  onVault: () => void;
}

/** Visible label of the first action (U2). */
export const RECEIVE_TILE_LABEL = 'Receive';

export function ActionRow({ onReceive, onSend, onSwap, onVault }: ActionRowProps) {
  const action = (label: string, icon: IconName, onClick: (event: MouseEvent<HTMLButtonElement>) => void) => (
    <button type="button" className="home-action" onClick={onClick}>
      <span className="home-action-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <span className="home-action-label">{label}</span>
    </button>
  );
  return (
    <div className="home-actions" role="group" aria-label="Wallet actions">
      {action(RECEIVE_TILE_LABEL, 'down', event => onReceive(event.currentTarget))}
      {action('Send', 'up', event => onSend(event.currentTarget))}
      {action('Swap', 'swap', () => onSwap())}
      {action('Vault', 'vault', () => onVault())}
    </div>
  );
}
