import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { DOC_GROUPS, DOC_PAGES, pageForPath, type DocPage } from './docs/registry';
import { DocLink, PageHead } from './docs/components';
import './docs/docs.css';

/**
 * ANTARA documentation. main.tsx routes every /docs* path (and the old /skill path) here; this component
 * picks the page from window.location.pathname, so /docs/<slug> works on reload and with back/forward.
 * The docs area is its own scroll container (the app shell keeps body overflow hidden).
 */
const HEADER_OFFSET = 88;

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function NotFound() {
  return <>
    <PageHead eyebrow="404 / DOCS" title="This page isn't in the docs" lead="The address may be old or mistyped. Every page is listed in the menu." />
    <ul className="adocs-list">{DOC_PAGES.map(page => <li key={page.path}><DocLink to={page.path}>{page.title}</DocLink> · {page.description}</li>)}</ul>
  </>;
}

/** The legacy /skill address shows the overview and is rewritten to /docs. */
function canonicalPath(pathname: string) {
  return pathname.replace(/\/+$/, '') === '/skill' ? '/docs' : pathname;
}

export default function Guide() {
  const [path, setPath] = useState(() => canonicalPath(window.location.pathname));
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const shownPath = useRef(path);

  // The legacy /skill address keeps working and becomes the canonical /docs.
  useEffect(() => {
    if (canonicalPath(window.location.pathname) !== window.location.pathname) {
      window.history.replaceState(window.history.state, '', `/docs${window.location.search}${window.location.hash}`);
    }
  }, [path]);

  useEffect(() => {
    const update = () => setPath(canonicalPath(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  const page = pageForPath(path);
  const index = page ? DOC_PAGES.indexOf(page) : -1;
  const previous = index > 0 ? DOC_PAGES[index - 1] : null;
  const next = index >= 0 && index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : null;

  useEffect(() => {
    const before = document.title;
    document.title = page ? (page.slug ? `${page.title} · ANTARA Docs` : 'ANTARA Docs') : 'Page not found · ANTARA Docs';
    return () => { document.title = before; };
  }, [page]);

  const scrollToId = useCallback((id: string, smooth: boolean) => {
    const container = root.current;
    const target = id ? document.getElementById(id) : null;
    if (!container || !target || !container.contains(target)) return false;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - HEADER_OFFSET + 16;
    container.scrollTo({ top: Math.max(0, top), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    return true;
  }, []);

  // A new page starts at the top (or at its #section); after an in-docs navigation the heading takes focus.
  useLayoutEffect(() => {
    setMenuOpen(false);
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!scrollToId(hash, false)) root.current?.scrollTo({ top: 0 });
    if (shownPath.current === path) return; // first load (and React's development re-run): leave focus alone
    shownPath.current = path;
    document.getElementById('adocs-title')?.focus({ preventScroll: true });
  }, [path, scrollToId]);

  // Highlight the section being read in the menu and the on-page list.
  useEffect(() => {
    const container = root.current;
    if (!container || !page) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top + HEADER_OFFSET + 40;
      let current = page.sections[0]?.id ?? '';
      for (const section of page.sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= top) current = section.id;
      }
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) current = page.sections[page.sections.length - 1]?.id ?? current;
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => { container.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [page]);

  useEffect(() => {
    if (!menuOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [menuOpen]);

  // In-page #links scroll the docs container and keep the address bar in step without a history entry.
  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href');
    if (!link || !href?.startsWith('#') || href.length < 2) return;
    const id = decodeURIComponent(href.slice(1));
    const target = document.getElementById(id);
    if (!target || !root.current?.contains(target)) return;
    event.preventDefault();
    if (id === 'adocs-main') { scrollToId(id, false); target.focus({ preventScroll: true }); return; }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${encodeURIComponent(id)}`);
    if (menuOpen) {
      // Close the menu first: the container cannot scroll while it is open.
      setMenuOpen(false);
      requestAnimationFrame(() => scrollToId(id, false));
    } else scrollToId(id, true);
  }

  const Page = page?.Component ?? NotFound;
  return <div className="adocs" ref={root} onClick={onClick} data-menu={menuOpen ? 'open' : 'closed'}>
    <a className="adocs-skip" href="#adocs-main">Skip to content</a>
    <header className="adocs-header">
      <DocLink to="/" className="adocs-brand" aria-label="ANTARA home"><img src="/antara/app-icon-192.png" alt="" width={28} height={28} /><span>ANTARA</span></DocLink>
      <DocLink to="/docs" className="adocs-pill">Docs</DocLink>
      <nav className="adocs-header-links" aria-label="ANTARA">
        <DocLink to="/" className="adocs-header-site">Website</DocLink>
        <DocLink to="/app" className="adocs-enter">Open wallet <span aria-hidden="true">→</span></DocLink>
      </nav>
      <button ref={menuButton} type="button" className="adocs-menu-button" aria-expanded={menuOpen} aria-controls="adocs-nav" onClick={() => setMenuOpen(open => !open)}>
        <span aria-hidden="true" className="adocs-menu-icon" data-open={menuOpen} />{menuOpen ? 'Close' : 'Menu'}
      </button>
    </header>

    <div className="adocs-body">
      <nav id="adocs-nav" className="adocs-nav" aria-label="Documentation" data-open={menuOpen}>
        {DOC_GROUPS.map(group => <div className="adocs-nav-group" key={group}>
          <p>{group}</p>
          <ul>{DOC_PAGES.filter(item => item.group === group).map(item => <NavItem key={item.path} item={item} current={item === page} active={active} />)}</ul>
        </div>)}
        <div className="adocs-nav-extra">
          <DocLink to="/app" className="adocs-button adocs-button-primary">Open wallet <span aria-hidden="true">→</span></DocLink>
          <DocLink to="/" className="adocs-button">Website</DocLink>
        </div>
      </nav>

      <main className="adocs-main" id="adocs-main" tabIndex={-1}>
        <article className="adocs-article" key={page?.path ?? 'not-found'}><Page /></article>
        {page && <nav className="adocs-pager" aria-label="Previous and next page">
          {previous ? <DocLink to={previous.path} className="adocs-pager-prev"><small>Previous</small><span>← {previous.title}</span></DocLink> : <span />}
          {next ? <DocLink to={next.path} className="adocs-pager-next"><small>Next</small><span>{next.title} →</span></DocLink> : <span />}
        </nav>}
        <footer className="adocs-footer">
          <span>ANTARA · Docs</span>
          <span>Describes the implementation as of October 13, 2026. Not a security audit.</span>
        </footer>
      </main>

      {page && page.sections.length > 0 && <aside className="adocs-toc" aria-label="On this page">
        <p>On this page</p>
        <ul>{page.sections.map(section => <li key={section.id} data-depth={section.depth ?? 0}><a href={`#${section.id}`} aria-current={active === section.id ? 'location' : undefined}>{section.label}</a></li>)}</ul>
      </aside>}
    </div>
  </div>;
}

function NavItem({ item, current, active }: { item: DocPage; current: boolean; active: string }) {
  // A nested section (a layer card) highlights its parent section in the menu.
  let position = item.sections.findIndex(section => section.id === active);
  while (position > 0 && item.sections[position].depth) position -= 1;
  const parent = position >= 0 ? item.sections[position].id : '';
  return <li>
    <DocLink to={item.path} className="adocs-nav-link" aria-current={current ? 'page' : undefined}>{item.nav}</DocLink>
    {current && <ul className="adocs-nav-sections">
      {item.sections.filter(section => !section.depth).map(section => <li key={section.id}><a href={`#${section.id}`} aria-current={parent === section.id ? 'location' : undefined}>{section.label}</a></li>)}
    </ul>}
  </li>;
}
