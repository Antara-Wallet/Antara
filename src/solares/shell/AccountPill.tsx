// Account pill (docs/UI_ARGUS_PARITY.md 6.3): network logo, wallet name, short address,
// a "Vault" tag while the Wallet screen is on its Vault side, and a chevron. Narrow
// layouts show the compact form (logo, short address, tag). It opens the account sheet,
// signed in or out. Asserted names: "Select wallet", "Sign in to ANTARA".
import { forwardRef } from 'react';
import { Icon } from '../ui';
import { TokenLogo } from '../TokenLogo';
import type { PillModel } from './accountModel';

export interface AccountPillProps {
  model: PillModel;
  authenticated: boolean;
  vaultSide: boolean;
  onOpen: () => void;
}

export const AccountPill = forwardRef<HTMLButtonElement, AccountPillProps>(function AccountPill({ model, authenticated, vaultSide, onOpen }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="shell-pill"
      data-signed-in={authenticated || undefined}
      aria-label={model.ariaLabel}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <span className="shell-pill-logo" aria-hidden="true">
        {authenticated ? <TokenLogo symbol={model.logo} /> : <Icon name="portfolio" size={17} />}
      </span>
      <span className="shell-pill-text">
        <strong>{model.title}</strong>
        <small>{model.subtitle}</small>
      </span>
      {vaultSide && authenticated && <span className="shell-pill-tag">Vault</span>}
      {authenticated && <Icon name="chevron" size={15} className="shell-pill-chevron" />}
    </button>
  );
});
