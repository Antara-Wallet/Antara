// Sign-in welcome (docs/UI_ARGUS_PARITY.md 6.2), replacing ARGUS's onboarding and unlock:
// Privy sign-in creates the Solana and EVM wallets, so there is no seed, password or
// username to show. Every fact line must stay true; the vault line appears only when the
// build pins a guardian, and never says a vault is available.
import { MEDIA } from '../ui';
import { PAIRED_GUARDIAN_SOLANA } from '../wallet/config';

export interface SignInWelcomeProps {
  configured: boolean;
  ready: boolean;
  onSignIn: () => void;
}

export const WELCOME_FACTS: readonly string[] = Object.freeze([
  'Solana and EVM wallets are created when you sign in.',
  'Send, receive and swap on Solana, Ethereum, BNB Smart Chain, Robinhood Chain and Base.',
]);
export const WELCOME_VAULT_FACT = 'Where ANTARA has switched it on, a Solana vault whose releases need your approval and ANTARA’s.';

export function SignInWelcome({ configured, ready, onSignIn }: SignInWelcomeProps) {
  const loading = configured && !ready;
  const facts = PAIRED_GUARDIAN_SOLANA ? [...WELCOME_FACTS, WELCOME_VAULT_FACT] : WELCOME_FACTS;
  return (
    <div className="home-welcome">
      <picture className="home-welcome-art" aria-hidden="true">
        <source media="(max-width: 640px), (max-height: 500px) and (pointer: coarse)" srcSet={MEDIA.orbitPortrait} />
        <img src={MEDIA.guardian} alt="" decoding="async" />
      </picture>
      <div className="home-welcome-copy">
        <p className="ui-eyebrow">ANTARA</p>
        <h2>Your wallet, across networks</h2>
        <ul className="home-welcome-facts">
          {facts.map(fact => <li key={fact}>{fact}</li>)}
        </ul>
        <button type="button" className="ui-btn-primary home-welcome-action" disabled={loading} onClick={onSignIn}>
          {!configured ? 'Open setup' : loading ? 'Wallet loading…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
