import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { navigate } from '../../lib/nav';
import { protectionLayers } from './protectionLayers';
import { SUPPORTED_NETWORKS } from '../networks';
import { LayerIcon } from '../verification/layerIcons';
import type { IntroState } from './LandingGlobe';
import './landing.css';

const LandingGlobe = lazy(() => import('./LandingGlobe'));
const chapters = ['Overview', 'Protection', 'Networks'] as const;
const networks = SUPPORTED_NETWORKS.map(network => network.name);
const motionKey = 'antara.landing.motion';
const introKey = 'antara.landing.intro';
const STILL = '/antara/planet/landing-globe-still.webp';
const STILL_ALT = 'ANTARA globe with six protection layers around one vault';
const tags = protectionLayers.map(layer => ({ index: layer.index, name: layer.name }));

function internalLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.getAttribute('href') || '/');
}
function readMotion() { try { return localStorage.getItem(motionKey) !== 'off'; } catch { return true; } }
function prefersReduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

/** Static star dust, drawn once per size from a fixed seed. Visible while the 3D chunk loads and without WebGL. */
function StarDust() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      const context = element.getContext('2d');
      if (!context || width < 2 || height < 2) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      let seed = 20261013;
      const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const count = Math.round(width * height / 1900);
      for (let index = 0; index < count; index++) {
        const x = random() * width, y = random() * height, size = random();
        const alpha = .1 + Math.pow(random(), 2.2) * .6;
        context.fillStyle = random() > .93 ? `rgba(255,236,214,${alpha})` : `rgba(206,224,255,${alpha})`;
        context.beginPath(); context.arc(x, y, size > .985 ? 1.1 : size > .9 ? .7 : .42, 0, Math.PI * 2); context.fill();
      }
    };
    const observer = new ResizeObserver(draw); observer.observe(element); draw();
    return () => observer.disconnect();
  }, []);
  return <canvas className="landing-stars" ref={canvas} aria-hidden="true" />;
}

export default function AntaraLanding() {
  const [active, setActive] = useState(0);
  const [layer, setLayer] = useState(0);
  const [hover, setHover] = useState(-1);
  const [motion, setMotion] = useState(readMotion);
  const [reduced, setReduced] = useState(prefersReduced);
  // The intro plays once: on a first visit, with motion allowed. It waits for the 3D scene, but never for long.
  const [intro, setIntro] = useState<IntroState>(() => {
    if (!readMotion() || prefersReduced()) return 'done';
    try { return localStorage.getItem(introKey) === 'seen' ? 'done' : 'pending'; } catch { return 'done'; }
  });
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const layerButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const animated = motion && !reduced;
  const detail = active === 1;
  const selected = protectionLayers[layer];
  const focus = hover >= 0 ? hover : detail ? layer : -1;

  const onIntro = useCallback((state: IntroState) => {
    setIntro(previous => previous === 'done' ? 'done' : state);
    if (state !== 'pending') try { localStorage.setItem(introKey, 'seen'); } catch { /* The intro simply plays again next time. */ }
  }, []);
  const selectLayer = useCallback((index: number) => { setLayer(index); setActive(1); }, []);
  const closeDetail = useCallback(() => { setActive(0); layerButtons.current[layer]?.focus(); }, [layer]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(preference.matches);
    preference.addEventListener('change', update);
    const previousTitle = document.title; document.title = 'ANTARA — One vault. Six shields.';
    return () => { preference.removeEventListener('change', update); document.title = previousTitle; };
  }, []);
  useEffect(() => {
    if (intro !== 'pending') return;
    const timer = window.setTimeout(() => setIntro(state => state === 'pending' ? 'done' : state), 2600);
    return () => window.clearTimeout(timer);
  }, [intro]);
  useEffect(() => {
    if (!detail && intro === 'done') return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (intro !== 'done') setIntro('done');
      else closeDetail();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [detail, intro, closeDetail]);
  function selectChapter(index: number, focusTab = false) {
    setActive(index);
    if (focusTab) tabs.current[index]?.focus();
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    let next: number;
    if (event.key === 'ArrowRight') next = (active + 1) % chapters.length;
    else if (event.key === 'ArrowLeft') next = (active + chapters.length - 1) % chapters.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = chapters.length - 1;
    else return;
    event.preventDefault(); selectChapter(next, true);
  }
  function toggleMotion() {
    const next = !motion; setMotion(next);
    try { localStorage.setItem(motionKey, next ? 'on' : 'off'); } catch { /* Keep the preference in memory when storage is unavailable. */ }
  }

  return <div className="antara-landing" data-chapter={active} data-motion={animated ? 'running' : 'still'} data-detail={detail} data-intro={intro}>
    <StarDust />
    <Suspense fallback={<div className="landing-globe" data-renderer="loading"><img className="landing-globe-still" src={STILL} alt={STILL_ALT} onError={event => { event.currentTarget.hidden = true; }} /></div>}>
      <LandingGlobe animated={animated} chapter={active} focus={focus} intro={intro} tags={tags} onSelectLayer={selectLayer} onHoverLayer={setHover} onIntro={onIntro} />
    </Suspense>
    <div className="landing-shade" aria-hidden="true" />
    <div className="landing-frame" aria-hidden="true"><i /><i /><i /><i /></div>
    <a className="landing-skip" href="#landing-panel">Skip to content</a>
    <header className="landing-header">
      <a href="/" className="landing-brand" aria-label="ANTARA home" onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); selectChapter(0);
      }}><img src="/antara/emblem-96.webp" alt="" width="26" height="26" /><span>ANTARA</span></a>
      <nav className="landing-nav" aria-label="Discover ANTARA"><div role="tablist" aria-label="Explore ANTARA">
        {chapters.map((item, index) => <button type="button" role="tab" id={`landing-tab-${index}`} key={item} aria-controls="landing-panel" aria-selected={active === index} tabIndex={active === index ? 0 : -1} ref={element => { tabs.current[index] = element; }} onKeyDown={navigateTabs} onClick={() => selectChapter(index)}><span className="landing-tab-index" aria-hidden="true">0{index + 1}</span>{item}</button>)}
      </div></nav>
      <div className="landing-header-links">
        <a className="landing-docs-link" href="/docs" onClick={internalLink}>Docs</a>
        <a className="landing-docs-link landing-download-link" href="/download" onClick={internalLink}>Download</a>
        <a className="landing-x" href="https://x.com/AntaraWallet" target="_blank" rel="noreferrer" aria-label="ANTARA on X (opens in a new tab)" title="Follow ANTARA on X">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
        </a>
        <a className="landing-enter" href="/app" onClick={internalLink}>Open wallet <span aria-hidden="true">→</span></a>
      </div>
    </header>

    <main className="landing-stage" id="landing-panel" role="tabpanel" aria-labelledby={`landing-tab-${active}`} tabIndex={-1}>
      <div className="landing-copy">
        <p className="landing-kicker"><span aria-hidden="true" />Solana-first wallet <b>/</b> Windows · Chrome · Web</p>
        {/* A selected layer takes over the headline; otherwise the product statement. */}
        <h1 data-layer={detail ? selected.id : undefined}>{detail
          ? <span className="landing-line landing-h1-accent"><span>{selected.name}.</span></span>
          : <><span className="landing-line"><span>One vault.</span></span><span className="landing-line landing-h1-accent"><span>Six shields.</span></span></>}</h1>
        <div className="landing-chapter" key={detail ? `layer-${layer}` : `chapter-${active}`}>
          {active === 0 && <>
            <p className="landing-lede">Your everyday wallet, with a 2-of-2 vault that ANTARA’s guardian co-signs only when every shield you set passes.</p>
            <div className="landing-ctas">
              <a className="landing-primary" href="/app" onClick={internalLink}>Open wallet <span aria-hidden="true">→</span></a>
              <a className="landing-secondary landing-download" href="/download" onClick={internalLink}>Download <span aria-hidden="true">↓</span></a>
              <a className="landing-secondary" href="/docs" onClick={internalLink}>Read the docs</a>
            </div>
          </>}
          {detail && <section className="landing-layer-detail" id="landing-layer-detail" aria-label={`${selected.short} protection details`}>
            <div className="landing-detail-top">
              <span className="landing-detail-index">{selected.index}</span>
              <span className="landing-detail-icon"><LayerIcon id={selected.id} size={18} /></span>
              <span className="landing-layer-index">{selected.label}</span>
              <button className="landing-detail-close" type="button" aria-label="Close layer details" onClick={closeDetail}>×</button>
            </div>
            <div aria-live="polite" aria-atomic="true">
              <h2>{selected.title}</h2>
              <p>{selected.description}</p>
              <dl className="landing-detail-facts">
                <div><dt>Checks</dt><dd>{selected.checks}</dd></div>
                <div><dt>Signal</dt><dd>{selected.signal}</dd></div>
                <div><dt>Setting</dt><dd>{selected.mode}</dd></div>
              </dl>
              <span className="landing-layer-status">{selected.status}</span>
            </div>
            <a href="/app#protection" onClick={internalLink} className="landing-detail-link">Open protection <span aria-hidden="true">↗</span></a>
          </section>}
          {active === 2 && <section className="landing-network-detail" aria-label="Supported networks">
            <h2>Five networks <b aria-hidden="true">·</b> Solana first</h2>
            <ol className="landing-network-list">
              {networks.map((name, index) => <li key={name}><b>0{index + 1}</b><span>{name}</span>{index === 0 && <em>Primary</em>}</li>)}
            </ol>
            <p className="landing-network-copy">One wallet across five networks, on the Windows app, the Chrome extension and the web.</p>
            <a className="landing-detail-link" href="/app#swap" onClick={internalLink}>Explore trading <span aria-hidden="true">↗</span></a>
          </section>}
        </div>
      </div>

      <div className="landing-layers" role="group" aria-label="Protection layers">
        {protectionLayers.map((item, index) => {
          const on = detail && layer === index;
          return <button type="button" key={item.id} ref={element => { layerButtons.current[index] = element; }} className="landing-layer-button" style={{ '--i': index } as CSSProperties} aria-label={item.name} aria-pressed={on} aria-controls={on ? 'landing-layer-detail' : undefined} data-on={hover === index}
            onClick={() => selectLayer(index)} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(-1)} onFocus={() => setHover(index)} onBlur={() => setHover(-1)}>
            <i className="landing-layer-bar" aria-hidden="true" />
            <span className="landing-layer-num">{item.index}</span>
            <span className="landing-layer-name">{item.name}</span>
            <span className="landing-layer-mode">{item.mode}</span>
          </button>;
        })}
      </div>
      <p className="landing-fig" aria-hidden="true">Fig. 01 — Six shields around one vault. Arcs are illustrative.</p>
    </main>

    <footer className="landing-footer">
      <p className="landing-networks"><span>Networks</span>{networks.map(name => <b key={name}>{name}</b>)}</p>
      <div className="landing-footer-actions">
        {intro !== 'done' && <button type="button" className="landing-skip-intro" onClick={() => setIntro('done')}>Skip intro</button>}
        <a className="landing-footer-x" href="https://x.com/AntaraWallet" target="_blank" rel="noreferrer" aria-label="ANTARA on X (opens in a new tab)"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>Follow on X</a>
        <a className="landing-footer-docs" href="/docs" onClick={internalLink}>Documentation ↗</a>
        <button type="button" onClick={toggleMotion} aria-label={motion ? 'Pause ambient motion' : 'Enable ambient motion'} aria-pressed={motion && !reduced} disabled={reduced} title={reduced ? 'Your system prefers reduced motion' : undefined}><span className="landing-motion-icon" aria-hidden="true">{motion && !reduced ? 'Ⅱ' : '▷'}</span>{reduced ? 'Motion off' : motion ? 'Motion on' : 'Motion off'}</button>
        <span className="landing-page-index" aria-hidden="true">0{active + 1} / 03</span>
      </div>
    </footer>
  </div>;
}
