/**
 * ANTARA's own media for art slots (docs/UI_ARGUS_PARITY.md 4.5). Nothing from
 * src/assets/** (the retired gold ARK art). Paths are served from public/.
 * The sign-in art is the bundled 1600 px WebP rendition (docs/art.ts has its provenance),
 * so the Chrome extension, which leaves landing-guardian.png out, carries it too.
 */
import guardianWelcome from '../docs/art/guardian-1600.webp';

export const MEDIA = Object.freeze({
  /** Wallet hero, Activity empty state (desktop). */
  observatory: '/antara/observatory.png',
  /** Vault hero (desktop). */
  sanctuary: '/antara/sanctuary.png',
  /** Sign-in welcome (desktop): the left half is clear for copy. */
  guardian: guardianWelcome,
  /** Every narrow hero. */
  orbitPortrait: '/antara/cinematic/vault-orbit-portrait.webp',
  /** Activation complete (desktop). */
  orbitWide: '/antara/cinematic/vault-orbit-wide.webp',
  /** Backdrop of the verification planet, at 35%. */
  spaceTerrain: '/antara/planet/space-terrain.png',
  /** Brand mark: 40px desktop, 27px narrow (the same emblem as emblem.png at 40 KB). */
  brandMark: '/antara/app-icon-192.png',
});

export type MediaName = keyof typeof MEDIA;
