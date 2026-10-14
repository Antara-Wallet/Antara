// Desktop sidebar (docs/UI_ARGUS_PARITY.md 5.1, 6.1), after the ARGUS PWA and the owner's
// Solflare reference: brand, the primary destinations Wallet, Vault, Swap, Activity and
// Protection, then Settings and Sign in / Sign out at the bottom. "Vault" opens the Vault
// side of the Wallet screen (`#vault`), so the selected account's Wallet/Vault pairing stays.
//
// Asserted by the browser specs: complementary "App navigation" with class `is-expanded`
// when expanded, and nav buttons named "Wallet", "Vault", "Swap", "Activity", "Protection",
// "Settings", "Sign in" / "Sign out". The internal page id stays "Portfolio" (`#portfolio`).
import { Icon, MEDIA, type IconName } from '../ui';
import { NAV_ITEMS, type NavItem, type Page } from './routes';

export const PAGE_ICONS: Readonly<Record<Page, IconName>> = Object.freeze({
  Portfolio: 'portfolio',
  Swap: 'swap',
  Activity: 'activity',
  Protection: 'shield',
  Settings: 'settings',
});
export const NAV_ICONS: Readonly<Record<NavItem, IconName>> = Object.freeze({ ...PAGE_ICONS, Vault: 'vault' });

/** The visible label of a page (U1: the "Portfolio" page reads "Wallet", as on mobile and in ARGUS). */
export function desktopLabel(page: Page): string {
  return page === 'Portfolio' ? 'Wallet' : page;
}

/** The visible label of a navigation item. */
export function navLabel(item: NavItem): string {
  return item === 'Vault' ? 'Vault' : desktopLabel(item);
}

export interface SidebarProps {
  page: Page;
  /** The Wallet screen is on its Vault side: "Vault" is current instead of "Wallet". */
  vaultActive?: boolean;
  expanded: boolean;
  /** Inert while a modal is open, or when the narrow layout hides the sidebar. */
  inert: boolean;
  authenticated: boolean;
  onNavigate: (page: Page) => void;
  /** Opens the Vault side. Without it, "Vault" opens the Wallet screen. */
  onOpenVault?: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function Sidebar({ page, vaultActive = false, expanded, inert, authenticated, onNavigate, onOpenVault, onSignIn, onSignOut }: SidebarProps) {
  const current: NavItem = page === 'Portfolio' && vaultActive ? 'Vault' : page;
  const item = (target: NavItem) => {
    const label = navLabel(target);
    return (
      <button
        key={target}
        type="button"
        className="shell-nav-button"
        title={expanded ? undefined : label}
        aria-label={label}
        aria-current={current === target ? 'page' : undefined}
        onClick={() => (target === 'Vault' ? (onOpenVault ? onOpenVault() : onNavigate('Portfolio')) : onNavigate(target))}
      >
        <Icon name={NAV_ICONS[target]} size={19} />
        <span>{label}</span>
      </button>
    );
  };
  return (
    <aside id="desktop-navigation" className={`shell-sidebar${expanded ? ' is-expanded' : ''}`} inert={inert} aria-label="App navigation">
      <button type="button" className="shell-brand" onClick={() => onNavigate('Portfolio')} aria-label="ANTARA home">
        <img className="shell-brand-mark" src={MEDIA.brandMark} width={40} height={40} alt="" aria-hidden="true" />
        <span className="shell-brand-word">ANTARA</span>
      </button>
      <nav className="shell-nav" aria-label="Primary">{NAV_ITEMS.map(item)}</nav>
      <div className="shell-nav-bottom">
        {item('Settings')}
        <button
          type="button"
          className="shell-nav-button"
          title={expanded ? undefined : authenticated ? 'Sign out' : 'Sign in'}
          aria-label={authenticated ? 'Sign out' : 'Sign in'}
          onClick={authenticated ? onSignOut : onSignIn}
        >
          <Icon name="lock" size={19} />
          <span>{authenticated ? 'Sign out' : 'Sign in'}</span>
        </button>
      </div>
    </aside>
  );
}
