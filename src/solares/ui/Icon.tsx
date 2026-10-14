// Functional icon set (docs/UI_ARGUS_PARITY.md 4.4): 24-unit grid, 1.6 stroke, round caps.
// The first 21 paths are the shell's existing set, unchanged; qr, book, shield, release,
// deposit and back are new; key marks the wallet settings sheet's "Export private key".
// Icons are always aria-hidden: the control carries the name.
// No decorative SVG belongs here.
import type { ReactNode } from 'react';

export const ICON_NAMES = [
  'portfolio', 'tokens', 'activity', 'vault', 'swap', 'settings', 'menu', 'down', 'up', 'close', 'copy',
  'eye', 'hidden', 'arrow', 'chevron', 'plus', 'refresh', 'lock', 'external', 'search', 'check',
  'qr', 'book', 'shield', 'release', 'deposit', 'back', 'key',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, ReactNode> = {
  portfolio: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="3" />
      <path d="M3 10h18m-6 4h3M7 5V3h10v2" />
    </>
  ),
  tokens: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 4 14 4 14 0V6M5 12v6c0 4 14 4 14 0v-6" />
    </>
  ),
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  vault: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  swap: <path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" />,
  settings: (
    <>
      <path d="m9 4 1-2h4l1 2 3 1 2 3-1 3v2l1 3-2 3-3 1-1 2h-4l-1-2-3-1-2-3 1-3v-2L4 8l2-3z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  down: <path d="M12 4v15m-6-6 6 6 6-6" />,
  up: <path d="M12 20V5m-6 6 6-6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  hidden: <path d="m3 3 18 18M10 5h2c6 0 10 7 10 7l-3 4M6 6l-4 6s4 7 10 7l4-1M9 9a4 4 0 0 0 6 6" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  plus: <path d="M12 4v16M4 12h16" />,
  refresh: <path d="M20 8A9 9 0 0 0 4 7L2 10m0-6v6h6M4 16a9 9 0 0 0 16 1l2-3m0 6v-6h-6" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" />
    </>
  ),
  external: <path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m5 12 5 5L20 7" />,
  // New in the parity build.
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM20 14v.01M18 18h2v2M14 20h.01" />
    </>
  ),
  book: (
    <>
      <path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" />
      <path d="M4 7h4M4 12h4M4 17h4" />
      <circle cx="12.5" cy="10" r="2" />
      <path d="M9.5 16c.6-1.5 1.7-2.3 3-2.3s2.4.8 3 2.3" />
    </>
  ),
  shield: <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z" />,
  // Arrow leaving a vault (Release) and arrow entering one (Deposit).
  release: (
    <>
      <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
      <path d="M10 12h11m-3-3 3 3-3 3" />
    </>
  ),
  deposit: (
    <>
      <path d="M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" />
      <path d="M3 12h11m-3-3 3 3-3 3" />
    </>
  ),
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.2 11.8 8.8-8.8m-3 3 3 3m-5.5-.5 2.5 2.5" />
    </>
  ),
};

export function Icon({ name, size = 19, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
