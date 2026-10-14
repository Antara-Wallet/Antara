// The six protection-layer icons of the landing planet (docs/UI_ARGUS_PARITY.md 6.6, 7.3).
// Paths copied from the private LayerIcon in landing/AntaraLanding.tsx, which stays unedited,
// keyed by layer id in landing order. Functional only: the control around an icon carries
// the layer's name, so every icon is aria-hidden.
import type { ReactNode } from 'react';
import type { LayerId } from '../layers/types';

const PATHS: Record<LayerId, ReactNode> = {
  bluetooth: <path d="m6 6 12 12-6 4V2l6 4L6 18" />,
  wifi: <><path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0" /><circle cx="12" cy="20" r=".8" /></>,
  biometrics: <><path d="M4 13v-2a8 8 0 0 1 16 0v3M7 16v-5a5 5 0 0 1 10 0v5M10 19v-8a2 2 0 0 1 4 0v4c0 3 1 5 2 6M4 17l-1 3M7 19l-1 3m7-7c0 3-1 6-2 7" /></>,
  geolocation: <><path d="M19 9c0 5-7 13-7 13S5 14 5 9a7 7 0 1 1 14 0Z" /><circle cx="12" cy="9" r="2.5" /></>,
  mfa: <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z" />,
  limits: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="#090c10" /><circle cx="15" cy="17" r="3" fill="#090c10" /></>,
};

export function LayerIcon({ id, size = 20, className }: { id: LayerId; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[id]}
    </svg>
  );
}
