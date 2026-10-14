import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { navigate } from '../../lib/nav';
import { copyText } from '../ui/address';
import { DOWNLOADS_MANIFEST_URL, formatSize, parseDownloadManifest, type DownloadEntry, type DownloadId, type DownloadManifest } from './downloadManifest';
import './download.css';

/**
 * Public download page (/download, /downloads). main.tsx lazy-loads it without the wallet provider.
 * Every button comes from public/downloads/manifest.json: a file is offered only with its size and
 * SHA-256, and anything not published shows "Coming soon". The page makes no other network request.
 */
const EXTENSION_ID = 'ckfkljfbjkmkjkkjkpbnmoehfipdcoin';

type LoadState = { status: 'loading' } | { status: 'ready'; manifest: DownloadManifest } | { status: 'error' };

function internalLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.getAttribute('href') || '/');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  return <button type="button" className="adl-copy" aria-label={label} onClick={async () => setState(await copyText(text) === 'copied' ? 'copied' : 'failed')}>
    <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
  </button>;
}

function FileFacts({ entry }: { entry: DownloadEntry }) {
  return <dl className="adl-facts">
    <div><dt>Version</dt><dd>{entry.version || '—'}</dd></div>
    <div><dt>Size</dt><dd>{formatSize(entry.size)}</dd></div>
    <div className="adl-hash"><dt>SHA-256</dt><dd><code>{entry.sha256}</code><CopyButton text={entry.sha256} label={`Copy the SHA-256 of ${entry.fileName}`} /></dd></div>
  </dl>;
}

function DownloadAction({ state, id, label }: { state: LoadState; id: DownloadId; label: string }) {
  const entry = state.status === 'ready' ? state.manifest.files[id] : undefined;
  if (entry) return <a className="adl-button adl-button-primary" href={entry.file} download={entry.fileName} data-download={id}>{label} <span aria-hidden="true">↓</span></a>;
  const text = state.status === 'loading' ? 'Checking…' : state.status === 'error' ? 'Unavailable' : 'Coming soon';
  return <button type="button" className="adl-button" disabled data-download={id}>{text}</button>;
}

function Card({ id, index, eyebrow, title, children }: { id: string; index: string; eyebrow: string; title: string; children: ReactNode }) {
  return <section className="adl-card" id={id} aria-labelledby={`${id}-title`}>
    <header className="adl-card-top"><span className="adl-index">{index}</span><span className="adl-eyebrow">{eyebrow}</span></header>
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
  </section>;
}

export default function DownloadPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: 'loading' });
    try {
      const response = await fetch(DOWNLOADS_MANIFEST_URL, { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = parseDownloadManifest(await response.json());
      setState({ status: 'ready', manifest });
    } catch (error) {
      if (signal?.aborted) return;
      console.warn('[ANTARA] Could not load the download list:', error instanceof Error ? error.message : error);
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    // /downloads is an alias; the address bar shows the canonical /download.
    if (window.location.pathname.replace(/\/+$/, '') === '/downloads') window.history.replaceState(window.history.state, '', `/download${window.location.search}${window.location.hash}`);
    const before = document.title; document.title = 'Download · ANTARA';
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); document.title = before; };
  }, [load]);

  const desktop = state.status === 'ready' ? state.manifest.files['desktop-windows'] : undefined;
  const extension = state.status === 'ready' ? state.manifest.files['chrome-extension'] : undefined;
  const version = state.status === 'ready' ? state.manifest.version : '';
  const installerName = desktop?.fileName ?? 'the ANTARA installer';
  const zipName = extension?.fileName ?? 'the zip';

  return <div className="adl">
    <a className="adl-skip" href="#adl-main">Skip to content</a>
    <header className="adl-header">
      <a href="/" className="adl-brand" aria-label="ANTARA home" onClick={internalLink}><img src="/antara/emblem-96.webp" alt="" width="24" height="24" /><span>ANTARA</span></a>
      <nav className="adl-header-links" aria-label="ANTARA">
        <a href="/docs" className="adl-header-link" onClick={internalLink}>Docs</a>
        <a href="/app" className="adl-enter" onClick={internalLink}>Open wallet <span aria-hidden="true">→</span></a>
      </nav>
    </header>

    <main className="adl-main" id="adl-main" tabIndex={-1}>
      <section className="adl-hero" aria-labelledby="adl-title">
        <p className="adl-kicker"><span aria-hidden="true" />Download{version && <> <b>/</b> v{version}</>}</p>
        <h1 id="adl-title"><span>Download</span> <span className="adl-accent">ANTARA.</span></h1>
        <p className="adl-lede">The same wallet on Windows, in Chrome’s side panel, or in your browser. Pick one; you can add the others later.</p>
        <aside className="adl-notice" aria-label="Early release">
          <strong>Early release</strong>
          <p>The Windows installer is not code-signed yet and the extension is not on the Chrome Web Store yet, so Windows and Chrome show the warnings described below. Funded end-to-end testing is not complete; start with small amounts.</p>
        </aside>
        {state.status === 'error' && <p className="adl-error" role="alert">The download list could not be loaded. <button type="button" onClick={() => void load()}>Try again</button></p>}
      </section>

      <div className="adl-grid">
        <Card id="desktop" index="01" eyebrow="Windows 10 / 11 · 64-bit" title="Desktop app">
          <p className="adl-desc">A native Windows app that opens straight into the wallet and uses Windows Hello directly.</p>
          <DownloadAction state={state} id="desktop-windows" label="Download for Windows" />
          {desktop ? <FileFacts entry={desktop} /> : state.status === 'ready' && <p className="adl-pending">The Windows installer is not published yet. Use the Chrome extension or the web app for now.</p>}
          <h3>Install</h3>
          <ol className="adl-steps">
            <li>Run <code>{installerName}</code>.</li>
            <li>If Windows SmartScreen says <b>“Windows protected your PC”</b>, choose <b>More info</b>, then <b>Run anyway</b>. It appears because the installer is not code-signed yet.</li>
            <li>Finish the installer, then open ANTARA.</li>
          </ol>
          <p className="adl-note">Requires Microsoft Edge WebView2, which is built into Windows 11.</p>
          {desktop && <p className="adl-note">To check the file in PowerShell, run <code>Get-FileHash .\{desktop.fileName}</code> and compare it with the SHA-256 above.</p>}
        </Card>

        <Card id="extension" index="02" eyebrow="Chrome 122+ · side panel" title="Chrome extension">
          <p className="adl-desc">The same wallet in Chrome’s side panel, next to any page you’re on. It injects nothing into the pages you visit.</p>
          <DownloadAction state={state} id="chrome-extension" label="Download extension (.zip)" />
          {extension ? <FileFacts entry={extension} /> : state.status === 'ready' && <p className="adl-pending">The extension download is not published yet.</p>}
          <h3>Install</h3>
          <ol className="adl-steps">
            <li>Unzip <code>{zipName}</code> into a folder you’ll keep. Chrome runs the extension from that folder, so don’t delete or move it.</li>
            <li>Open <code>chrome://extensions</code> <CopyButton text="chrome://extensions" label="Copy chrome://extensions" /> in the address bar and turn on <b>Developer mode</b> (top right).</li>
            <li>Choose <b>Load unpacked</b> and select the unzipped folder, the one that contains <code>manifest.json</code>.</li>
            <li>Pin ANTARA from the puzzle-piece menu, then click it to open the side panel.</li>
          </ol>
          <p className="adl-note">The extension card shows the ID <code>{EXTENSION_ID}</code>. Chrome asks for the side panel, your location (read only when a vault’s Safe Zones layer needs it) and access to <code>antara.tech</code>.</p>
          <p className="adl-note">Chrome Web Store listing coming soon. Until then Chrome may remind you that a developer-mode extension is installed. To update, unzip a newer download over the same folder and press reload on the extension card.</p>
        </Card>

        <Card id="web" index="03" eyebrow="Any modern browser" title="Use in your browser">
          <p className="adl-desc">Nothing to install. Open the wallet at <code>antara.tech/app</code> and sign in.</p>
          <a className="adl-button adl-button-secondary" href="/app" onClick={internalLink}>Open web wallet <span aria-hidden="true">→</span></a>
          <p className="adl-note">On the web, ANTARA’s server also delivers the app’s code. The desktop app and the extension carry their code inside the download.</p>
        </Card>
      </div>
    </main>

    <footer className="adl-footer">
      <span>ANTARA · Download</span>
      <span>Files are served from this site. The SHA-256 confirms a download is complete and unchanged.</span>
      <a href="/docs/getting-started" onClick={internalLink}>Getting started ↗</a>
    </footer>
  </div>;
}
