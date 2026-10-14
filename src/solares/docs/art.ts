/**
 * Page-header art for the docs as small WebP renditions, so a banner 132-196 px tall no longer loads a
 * 1.5-2.7 MB PNG. Provenance: each file is the owned artwork in public/antara/ (sources and prompts in
 * docs/ART.md), resized with Lanczos to 800 and 1600 px wide and saved as WebP quality 74 (Pillow 12.2,
 * 2026-10-13). Nothing else was changed, so object-position values written for the PNGs still apply.
 * Regenerate from the PNGs if those change.
 */
import observatory800 from './art/observatory-800.webp';
import observatory1600 from './art/observatory-1600.webp';
import sanctuary800 from './art/sanctuary-800.webp';
import sanctuary1600 from './art/sanctuary-1600.webp';
import guardian800 from './art/guardian-800.webp';
import guardian1600 from './art/guardian-1600.webp';
import earthObsidian800 from './art/earth-obsidian-800.webp';
import earthObsidian1600 from './art/earth-obsidian-1600.webp';
import spaceTerrain800 from './art/space-terrain-800.webp';
import spaceTerrain1600 from './art/space-terrain-1600.webp';

export interface DocArt { src: string; srcSet?: string }

const pair = (small: string, large: string): DocArt => ({ src: large, srcSet: `${small} 800w, ${large} 1600w` });

export const DOC_ART = {
  /** public/antara/observatory.png */
  observatory: pair(observatory800, observatory1600),
  /** public/antara/sanctuary.png */
  sanctuary: pair(sanctuary800, sanctuary1600),
  /** public/antara/landing-guardian.png */
  guardian: pair(guardian800, guardian1600),
  /** public/antara/planet/earth-obsidian.png */
  earthObsidian: pair(earthObsidian800, earthObsidian1600),
  /** public/antara/planet/space-terrain.png */
  spaceTerrain: pair(spaceTerrain800, spaceTerrain1600),
  /** Already a 135 KB WebP; used as is. */
  vaultOrbit: { src: '/antara/cinematic/vault-orbit-wide.webp' },
} as const satisfies Record<string, DocArt>;
