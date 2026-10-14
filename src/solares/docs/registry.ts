import type { ComponentType } from 'react';
import Overview from './pages/Overview';
import GettingStarted from './pages/GettingStarted';
import Wallet from './pages/Wallet';
import Vault from './pages/Vault';
import Security from './pages/Security';
import Architecture from './pages/Architecture';
import Faq from './pages/Faq';
import Roadmap from './pages/Roadmap';

export interface DocSection { id: string; label: string; depth?: 1 }
export interface DocPage {
  slug: string;
  path: string;
  title: string;
  nav: string;
  group: 'Start' | 'Product' | 'Reference';
  description: string;
  sections: DocSection[];
  Component: ComponentType;
}

export const DOC_PAGES: readonly DocPage[] = [
  { slug: '', path: '/docs', title: 'Overview', nav: 'Overview', group: 'Start', Component: Overview,
    description: 'A regular wallet, a multisig vault you create from it, and the security layers you put around the vault.',
    sections: [{ id: 'model', label: 'The model in three steps' }, { id: 'release-path', label: 'What happens when you release' }, { id: 'compare', label: 'Wallet and vault' }, { id: 'kinds', label: 'Three kinds of check' }, { id: 'status', label: 'Where things stand' }, { id: 'next', label: 'Read next' }] },
  { slug: 'getting-started', path: '/docs/getting-started', title: 'Getting started', nav: 'Getting started', group: 'Start', Component: GettingStarted,
    description: 'Install ANTARA, sign in, fund your wallet and activate your vault.',
    sections: [{ id: 'choose', label: 'Choose an app' }, { id: 'desktop', label: 'Desktop (Windows)' }, { id: 'extension', label: 'Chrome extension' }, { id: 'web', label: 'Web app' }, { id: 'sign-in', label: 'Sign in' }, { id: 'fund', label: 'Fund your wallet' }, { id: 'activate', label: 'Create your vault' }] },
  { slug: 'wallet', path: '/docs/wallet', title: 'Wallet', nav: 'Wallet', group: 'Product', Component: Wallet,
    description: 'Networks, stablecoins, receive, send and swaps.',
    sections: [{ id: 'what', label: 'What the wallet is' }, { id: 'networks', label: 'Networks and stablecoins' }, { id: 'receive', label: 'Receive' }, { id: 'send', label: 'Send' }, { id: 'swap', label: 'Swap' }, { id: 'activity', label: 'Activity' }, { id: 'not-protected', label: 'What it does not protect' }] },
  { slug: 'vault', path: '/docs/vault', title: 'Vault', nav: 'Vault', group: 'Product', Component: Vault,
    description: 'The Solana 2-of-2 vault, the guardian, releases, optional limits and recovery.',
    sections: [{ id: 'what', label: 'What the vault is' }, { id: 'two-of-two', label: 'Two signatures' }, { id: 'guardian', label: 'The guardian' }, { id: 'activation', label: 'Create your vault' }, { id: 'deposit', label: 'Deposit' }, { id: 'release', label: 'Release' }, { id: 'limits', label: 'Optional limits' }, { id: 'offline', label: 'If ANTARA is offline' }, { id: 'recovery', label: 'Recovery' }, { id: 'evm', label: 'EVM vaults' }] },
  { slug: 'security', path: '/docs/security', title: 'Security layers', nav: 'Security layers', group: 'Product', Component: Security,
    description: 'Biometrics, MFA, Safe Zones, Wi-Fi, Bluetooth and Limits: what each checks and what it cannot do.',
    sections: [{ id: 'how', label: 'How layers work' }, { id: 'kinds', label: 'Three kinds of check' }, { id: 'layers', label: 'The six layers' },
      { id: 'biometrics', label: 'Biometrics', depth: 1 }, { id: 'mfa', label: 'MFA', depth: 1 }, { id: 'geolocation', label: 'Safe Zones', depth: 1 }, { id: 'wifi', label: 'Wi-Fi', depth: 1 }, { id: 'bluetooth', label: 'Bluetooth', depth: 1 }, { id: 'limits', label: 'Limits', depth: 1 },
      { id: 'devices', label: 'Trusted devices' }, { id: 'changes', label: 'Turning layers on and off' }, { id: 'where', label: 'Which layer works where' }, { id: 'cannot', label: 'What layers cannot do' }] },
  { slug: 'architecture', path: '/docs/architecture', title: 'Architecture', nav: 'Architecture', group: 'Reference', Component: Architecture,
    description: 'Privy, Squads v4, the guardian, the ANTARA API, Relay, RPCs, and where data is stored.',
    sections: [{ id: 'overview', label: 'The pieces' }, { id: 'privy', label: 'Privy' }, { id: 'squads', label: 'Squads v4' }, { id: 'guardian', label: 'The guardian' }, { id: 'api', label: 'ANTARA API' }, { id: 'relay', label: 'Relay' }, { id: 'rpc', label: 'Network access' }, { id: 'data', label: 'Where data is stored' }, { id: 'apps', label: 'Three apps' }] },
  { slug: 'faq', path: '/docs/faq', title: 'FAQ', nav: 'FAQ', group: 'Reference', Component: Faq,
    description: 'Short, honest answers about the wallet, the vault, layers and recovery.',
    sections: [{ id: 'general', label: 'General' }, { id: 'wallet', label: 'Wallet' }, { id: 'vault', label: 'Vault' }, { id: 'layers', label: 'Security layers' }, { id: 'recovery', label: 'Recovery' }] },
  { slug: 'roadmap', path: '/docs/roadmap', title: 'Roadmap', nav: 'Roadmap', group: 'Reference', Component: Roadmap,
    description: 'Built, go-live checks and planned.',
    sections: [{ id: 'built', label: 'Built, not live yet' }, { id: 'go-live', label: 'Before go-live' }, { id: 'planned', label: 'Planned' }] },
];

export const DOC_GROUPS = ['Start', 'Product', 'Reference'] as const;

/** `/docs`, `/docs/`, `/docs/<slug>` (case-insensitive, trailing slash ignored). Unknown slugs return null. */
export function pageForPath(pathname: string): DocPage | null {
  const clean = pathname.replace(/\/+$/, '').toLowerCase();
  if (clean === '/docs' || clean === '/skill') return DOC_PAGES[0];
  const match = clean.match(/^\/docs\/([a-z0-9-]+)$/);
  return match ? DOC_PAGES.find(page => page.slug === match[1]) ?? null : null;
}
