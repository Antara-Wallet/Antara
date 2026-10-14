// Tokens | Activity on the Wallet side (docs/UI_ARGUS_PARITY.md 6.4; ARGUS's underline
// tabs). The last choice is remembered in localStorage `solares.home.tab`, read and
// written defensively. Arrow, Home and End keys move between the tabs.
import { useState, type KeyboardEvent, type ReactNode } from 'react';

export type HomeTab = 'tokens' | 'activity';
export const HOME_TAB_KEY = 'solares.home.tab';
const TABS: readonly { id: HomeTab; label: string }[] = [{ id: 'tokens', label: 'Tokens' }, { id: 'activity', label: 'Activity' }];

export function readHomeTab(): HomeTab {
  try {
    return localStorage.getItem(HOME_TAB_KEY) === 'activity' ? 'activity' : 'tokens';
  } catch {
    return 'tokens';
  }
}
function writeHomeTab(tab: HomeTab) {
  try { localStorage.setItem(HOME_TAB_KEY, tab); } catch { /* The choice lasts for this visit. */ }
}

export function useHomeTab(): [HomeTab, (tab: HomeTab) => void] {
  const [tab, setTab] = useState<HomeTab>(readHomeTab);
  return [tab, next => { setTab(next); writeHomeTab(next); }];
}

export interface HomeTabsProps {
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  /** Controls beside the tabs (search, network filter, refresh); shown with Tokens only. */
  controls?: ReactNode;
  tokens: ReactNode;
  activity: ReactNode;
}

export function HomeTabs({ tab, onTab, controls, tokens, activity }: HomeTabsProps) {
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: HomeTab = event.key === 'Home' ? 'tokens' : event.key === 'End' ? 'activity' : tab === 'tokens' ? 'activity' : 'tokens';
    onTab(next);
    document.getElementById(`home-tab-${next}`)?.focus();
  };
  return (
    <section className="home-tabs ui-card" aria-label="Wallet assets">
      <div className="home-tabs-head">
        <div className="home-tablist" role="tablist" aria-label="Wallet sections">
          {TABS.map(item => (
            <button
              key={item.id}
              id={`home-tab-${item.id}`}
              type="button"
              role="tab"
              className="home-tab"
              aria-selected={tab === item.id}
              aria-controls={tab === item.id ? `home-panel-${item.id}` : undefined}
              tabIndex={tab === item.id ? 0 : -1}
              onKeyDown={onKey}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'tokens' && controls && <div className="home-controls">{controls}</div>}
      </div>
      <div id={`home-panel-${tab}`} role="tabpanel" aria-labelledby={`home-tab-${tab}`} className="home-panel">
        {tab === 'tokens' ? tokens : activity}
      </div>
    </section>
  );
}
