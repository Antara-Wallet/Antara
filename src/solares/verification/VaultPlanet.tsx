// The verification planet (docs/UI_ARGUS_PARITY.md 7.1): the landing's planet and ring
// (AntaraSculpture, variant "vault") with one station per protection layer. Stations show
// only what `states` says, and `states` comes only from server answers (stationState.ts).
//
// - Animated only when motion is allowed: the caller's switch, no reduced-motion
//   preference, a visible window, no `data-motion="off"` on an ancestor, and never in the
//   extension side panel (still frames on demand, to save power).
// - Wide: leader-line labels (StationRail) at the stations' projected positions.
//   Narrow (≤600px of its own width), or without WebGL: the 3×2 StationChips.
// - Without WebGL, or after a lost context, the sculpture shows vault-still.webp; the
//   station list and its labels are unchanged.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { NodePosition } from '../landing/AntaraSculpture';
import type { LayerId } from '../layers/types';
import { MEDIA } from '../ui/media';
import { StationChips, type StationItem } from './StationChips';
import { StationRail } from './StationRail';
import './verification.css';

const AntaraSculpture = lazy(() => import('../landing/AntaraSculpture'));

export const VAULT_PLANET_LABEL = 'ANTARA vault planet with six protection stations. Station status is listed below.';
/** Where the stations sit before the scene reports their projected positions (the vault framing at 16:10). */
const DEFAULT_POSITIONS: NodePosition[] = [
  { x: .335, y: .25, visible: true }, { x: .675, y: .3, visible: true }, { x: .27, y: .5, visible: true },
  { x: .735, y: .57, visible: true }, { x: .615, y: .79, visible: true }, { x: .375, y: .74, visible: true },
];

type Renderer = 'loading' | 'ready' | 'fallback';

/** Motion allowed by the system, the window and any `data-motion="off"` / `data-window-hidden` ancestor. */
function useAmbientMotion(host: RefObject<HTMLElement | null>) {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const [ancestorOff, setAncestorOff] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(preference.matches);
    const visibility = () => setVisible(!document.hidden);
    preference.addEventListener('change', update); document.addEventListener('visibilitychange', visibility);
    const element = host.current;
    const read = () => setAncestorOff(!!element?.parentElement?.closest('[data-motion="off"], [data-window-hidden="true"]'));
    read();
    // The shell mirrors its "Celestial motion" switch and window visibility as attributes.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-motion', 'data-window-hidden'] });
    return () => { preference.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); observer.disconnect(); };
  }, [host]);
  const sidePanel = typeof document !== 'undefined' && document.documentElement.dataset.surface === 'sidepanel';
  return !reduced && visible && !ancestorOff && !sidePanel;
}

export function VaultPlanet({ states, onSelect, motion = true, labels = 'auto', size = 'hero', label = VAULT_PLANET_LABEL, className }: {
  /** Six stations in landing order, from stationStates(). */
  states: readonly StationItem[];
  /** Opens Vault protection layers at that layer. */
  onSelect?: (id: LayerId) => void;
  /** The in-app "Celestial motion" switch. */
  motion?: boolean;
  /** 'auto': rail when wide and WebGL renders, else chips. 'none' leaves the list to the caller. */
  labels?: 'auto' | 'rail' | 'chips' | 'none';
  /** 'hero' for the verification sequence and Protection, 'compact' for activation. */
  size?: 'hero' | 'compact';
  label?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<NodePosition[]>(DEFAULT_POSITIONS);
  const [renderer, setRenderer] = useState<Renderer>('loading');
  const [narrow, setNarrow] = useState(false);
  const animated = useAmbientMotion(host) && motion;
  const updatePositions = useCallback((next: NodePosition[]) => setPositions(next), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setNarrow(element.getBoundingClientRect().width <= 600);
    const readRenderer = () => {
      const value = element.querySelector('.landing-sculpture')?.getAttribute('data-renderer');
      setRenderer(value === 'ready' || value === 'fallback' ? value : 'loading');
    };
    measure(); readRenderer();
    const resize = new ResizeObserver(measure); resize.observe(element);
    const mutation = new MutationObserver(readRenderer);
    mutation.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-renderer'] });
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, []);

  const stations = states.map(item => item.visual);
  const list = labels === 'none' ? null
    : labels === 'chips' || (labels === 'auto' && (narrow || renderer === 'fallback')) ? 'chips' : 'rail';
  return (
    <div ref={host} className={`vseq-planet${className ? ` ${className}` : ''}`} data-size={size} data-renderer={renderer} data-list={list ?? 'none'}>
      <div className="vseq-planet-stage">
        {/* The frame clips the art; the rail may reach past it. */}
        <div className="vseq-planet-frame">
          <div className="vseq-planet-backdrop" aria-hidden="true" style={{ backgroundImage: `url("${MEDIA.spaceTerrain}")` }} />
          <Suspense fallback={<div className="landing-sculpture vseq-planet-loading" data-renderer="loading"><img className="landing-emblem-fallback" src="/antara/planet/vault-still.webp" alt={label} /></div>}>
            <AntaraSculpture animated={animated} layer={-1} stations={stations} variant="vault" label={label}
              onSelectLayer={onSelect ? index => { const item = states[index]; if (item) onSelect(item.id); } : undefined}
              onNodePositions={updatePositions} />
          </Suspense>
        </div>
        {list === 'rail' && <StationRail states={states} positions={positions} onSelect={onSelect} />}
      </div>
      {list === 'chips' && <StationChips states={states} onSelect={onSelect} />}
    </div>
  );
}
