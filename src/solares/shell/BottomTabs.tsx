// Narrow bottom tab bar (docs/UI_ARGUS_PARITY.md 5.2, 6.1): Wallet, Vault, Swap, Activity,
// Protection. Settings stays on the topbar gear. "Vault" opens the Vault side of the Wallet
// screen (`#vault`). Asserted: navigation "Mobile navigation" with buttons "Wallet", "Vault",
// "Swap", "Activity", "Protection", each at least 44px tall.
import { Icon } from '../ui';
import { NAV_ITEMS, type NavItem, type Page } from './routes';
import { NAV_ICONS, desktopLabel, navLabel } from './Sidebar';

/** The narrow label of a page: the same as desktop since U1 ("Wallet"). */
export function narrowLabel(page: Page): string {
  return desktopLabel(page);
}

export interface BottomTabsProps {
  page: Page;
  /** The Wallet screen is on its Vault side. */
  vaultActive?: boolean;
  onNavigate: (page: Page) => void;
  /** Opens the Vault side. Without it, "Vault" opens the Wallet screen. */
  onOpenVault?: () => void;
}

export function BottomTabs({ page, vaultActive = false, onNavigate, onOpenVault }: BottomTabsProps) {
  const current: NavItem = page === 'Portfolio' && vaultActive ? 'Vault' : page;
  return (
    <nav className="mobile-tabbar shell-tabbar" aria-label="Mobile navigation">
      {NAV_ITEMS.map(target => (
        <button
          key={target}
          type="button"
          aria-label={navLabel(target)}
          aria-current={current === target ? 'page' : undefined}
          onClick={() => (target === 'Vault' ? (onOpenVault ? onOpenVault() : onNavigate('Portfolio')) : onNavigate(target))}
        >
          <span className="shell-tab-icon"><Icon name={NAV_ICONS[target]} size={21} /></span>
          <span className="shell-tab-label">{navLabel(target)}</span>
        </button>
      ))}
    </nav>
  );
}
