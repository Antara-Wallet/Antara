import { useLayoutEffect, useRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { navigate } from '../../lib/nav';
import type { DocArt } from './art';

/** Same-origin links navigate inside the app (no reload); modified clicks keep the browser default. */
export function internalClick(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  event.preventDefault();
  navigate(href);
}

export function DocLink({ to, children, onClick, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <a {...rest} href={to} onClick={event => { onClick?.(event); internalClick(event); }}>{children}</a>;
}

export function Section({ id, title, children, lead }: { id: string; title: string; children: ReactNode; lead?: ReactNode }) {
  return <section className="adocs-section" id={id} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{title}<a className="adocs-anchor" href={`#${id}`} aria-label={`Link to ${title}`}>#</a></h2>
    {lead && <p className="adocs-section-lead">{lead}</p>}
    {children}
  </section>;
}

/** `notlive` marks something built but not switched on; it must never look like `built` or `live`. */
export type TagTone = 'built' | 'live' | 'progress' | 'planned' | 'required' | 'notlive' | 'neutral';
export function Tag({ tone = 'neutral', children }: { tone?: TagTone; children: ReactNode }) {
  return <span className="adocs-tag" data-tone={tone}>{children}</span>;
}

export type LayerKind = 'cryptographic' | 'server-observed' | 'device-reported';
const KIND_LABEL: Record<LayerKind, string> = { cryptographic: 'Cryptographic', 'server-observed': 'Server-observed', 'device-reported': 'Device-reported' };
export function Kind({ kind }: { kind: LayerKind }) {
  return <span className="adocs-kind" data-kind={kind}><i aria-hidden="true" />{KIND_LABEL[kind]}</span>;
}

export function Callout({ tone = 'note', title, children }: { tone?: 'note' | 'warn' | 'status'; title: string; children: ReactNode }) {
  return <aside className="adocs-callout" data-tone={tone} aria-label={title}>
    <strong>{title}</strong>
    <div>{children}</div>
  </aside>;
}

/** Wide content scrolls inside its own region on small screens, never the page. */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  // On narrow screens each row stacks; every cell repeats its column heading (data-label, read by CSS).
  useLayoutEffect(() => {
    const table = wrap.current?.querySelector('table');
    if (!table) return;
    const headings = [...table.querySelectorAll('thead th')].map(cell => cell.textContent?.trim() ?? '');
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.children].forEach((cell, column) => { if (headings[column]) cell.setAttribute('data-label', headings[column]); });
    }
  });
  return <div ref={wrap} className="adocs-table" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function Steps({ children, label }: { children: ReactNode; label?: string }) {
  return <ol className="adocs-steps" aria-label={label}>{children}</ol>;
}

export function Step({ title, children }: { title: string; children: ReactNode }) {
  return <li><strong>{title}</strong><div>{children}</div></li>;
}

export function Code({ children, label }: { children: string; label: string }) {
  return <figure className="adocs-code"><figcaption>{label}</figcaption><pre tabIndex={0}><code>{children}</code></pre></figure>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="adocs-mono">{children}</code>;
}

export function Cards({ children, columns = 3 }: { children: ReactNode; columns?: 2 | 3 }) {
  return <div className="adocs-cards" data-columns={columns}>{children}</div>;
}

export function LinkCard({ to, eyebrow, title, children }: { to: string; eyebrow: string; title: string; children: ReactNode }) {
  return <DocLink to={to} className="adocs-linkcard">
    <span className="adocs-eyebrow">{eyebrow}</span>
    <strong>{title}</strong>
    <span>{children}</span>
    <em aria-hidden="true">→</em>
  </DocLink>;
}

/** Page title block. The artwork is decorative; the h1 takes focus after an in-docs navigation. */
export function PageHead({ eyebrow, title, lead, art, artPosition = 'center' }: { eyebrow: string; title: string; lead: ReactNode; art?: DocArt; artPosition?: string }) {
  return <header className="adocs-pagehead" data-art={art ? 'true' : 'false'}>
    {art && <div className="adocs-pagehead-art" aria-hidden="true"><img src={art.src} srcSet={art.srcSet} sizes={art.srcSet ? '(max-width: 900px) calc(100vw - 32px), 800px' : undefined} alt="" decoding="async" style={{ objectPosition: artPosition }} /></div>}
    <p className="adocs-eyebrow">{eyebrow}</p>
    <h1 id="adocs-title" tabIndex={-1}>{title}</h1>
    <p className="adocs-lead">{lead}</p>
  </header>;
}

/** The dated, honest status note repeated where a reader might otherwise assume something is live. */
export function StatusNote() {
  return <Callout tone="status" title="Status on October 13, 2026">
    <p>The wallet, the Solana vault and its six layers are built and covered by automated tests. ANTARA&apos;s vault guardian is <b>not switched on yet</b>, so no vault can be activated until it is; the app says so instead of showing a vault. A real sign-in has not been verified in any app yet. No test with real funds and no hands-on hardware test of the layers has been completed, and ANTARA has not been audited.</p>
  </Callout>;
}
