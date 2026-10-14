// Topbar (docs/UI_ARGUS_PARITY.md 5.1, 5.2, 6.1).
// Desktop (73px): the navigation collapse toggle and the page title; the account pill on the right.
// Narrow (64px): the brand mark (27px) and the page title; the compact account pill and the
// settings gear on the right (the gear reads "Back to wallet" on Settings, as asserted).
import type { ReactNode } from 'react';
import { Icon, MEDIA } from '../ui';

export interface TopbarProps {
  title: string;
  narrow: boolean;
  navExpanded: boolean;
  onToggleNav: () => void;
  onSettingsGear: () => void;
  onSettingsPage: boolean;
  pill: ReactNode;
}

export function Topbar({ title, narrow, navExpanded, onToggleNav, onSettingsGear, onSettingsPage, pill }: TopbarProps) {
  return (
    <header className="shell-topbar">
      <div className="shell-topbar-start">
        {narrow ? (
          <img className="shell-brand-small" src={MEDIA.brandMark} width={27} height={27} alt="ANTARA" />
        ) : (
          <button
            type="button"
            className="ui-icon-btn shell-nav-toggle"
            aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            aria-expanded={navExpanded}
            aria-controls="desktop-navigation"
            onClick={onToggleNav}
          >
            <Icon name="menu" />
          </button>
        )}
        <h1>{title}</h1>
      </div>
      <div className="shell-topbar-end">
        {pill}
        {narrow && (
          <button
            type="button"
            className="ui-icon-btn shell-settings"
            aria-label={onSettingsPage ? 'Back to wallet' : 'Settings'}
            onClick={onSettingsGear}
          >
            <Icon name={onSettingsPage ? 'close' : 'settings'} size={20} />
          </button>
        )}
      </div>
    </header>
  );
}
