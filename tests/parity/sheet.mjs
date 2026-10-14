// Parity comparison sheets (docs/UI_ARGUS_PARITY.md 10.2, 10.5). Run with node after one
// or both runs:
//   node tests/parity/sheet.mjs
//   $env:ARGUS_REF_DIR='<ARGUS_SHOTS folder>'; node tests/parity/sheet.mjs   (adds the ARGUS references)
// Reads artifacts/ui-parity/{before,after}/manifest.json and writes, per scenario,
// artifacts/ui-parity/compare/<id>.html and <id>.png (rendered by headless Chromium),
// plus compare/index.html. Local files only: the page never loads anything remote.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = path.resolve('artifacts/ui-parity');
const COMPARE = path.join(OUT, 'compare');
const ARGUS = process.env.ARGUS_REF_DIR ? path.resolve(process.env.ARGUS_REF_DIR) : null;
const SURFACE_ORDER = ['desktop', 'desktop-wide', 'mobile', 'panel-360', 'panel-420'];

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function readManifest(run) {
  const file = path.join(OUT, run, 'manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const runs = { before: readManifest('before'), after: readManifest('after') };
if (!runs.before && !runs.after) {
  console.error('No parity manifest found. Run the parity capture first (see tests/parity/run.spec.ts).');
  process.exit(1);
}

/** id → { meta, cells: Map<surface, { before?: result, after?: result }> } in manifest order. */
const scenarios = new Map();
for (const run of ['before', 'after']) {
  for (const result of runs[run]?.results ?? []) {
    if (!scenarios.has(result.id)) scenarios.set(result.id, { meta: result, cells: new Map() });
    const entry = scenarios.get(result.id);
    if (run === 'after') entry.meta = result;
    if (!entry.cells.has(result.surface)) entry.cells.set(result.surface, {});
    entry.cells.get(result.surface)[run] = result;
  }
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #08090b; color: #eaf1ff; font: 13px/1.5 'Inter', system-ui, sans-serif; }
  h1 { font: 600 22px/1.2 system-ui, sans-serif; margin: 0 0 4px; }
  .meta { color: #9aa5b6; margin: 0 0 18px; }
  .argus { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 18px; }
  .argus figure { margin: 0; }
  .argus img { max-height: 360px; max-width: 520px; border: 1px solid #ffffff14; border-radius: 6px; }
  table { border-collapse: collapse; }
  th, td { vertical-align: top; text-align: left; padding: 8px 12px 14px 0; }
  th { color: #9aa5b6; font-weight: 500; font-size: 12px; }
  td.surface { color: #c9d2df; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .cell img { display: block; max-width: 720px; border: 1px solid #ffffff14; border-radius: 6px; }
  .cell .empty { width: 240px; height: 120px; display: grid; place-items: center; border: 1px dashed #ffffff26; border-radius: 6px; color: #6f7a8a; text-align: center; padding: 8px; }
  .status { font-size: 12px; color: #9aa5b6; margin-top: 4px; max-width: 720px; }
  .status.failed { color: #ff8f86; }
  figcaption { color: #9aa5b6; font-size: 11px; margin-top: 4px; }
  a { color: #9cbfff; }
`;

function cell(result, run) {
  if (!result) return `<div class="empty">no ${run} capture</div>`;
  if (result.status === 'skipped') return `<div class="empty">${escape(result.reason || 'skipped')}</div>`;
  const image = result.files?.viewport ? `<img src="${escape(`../${run}/${result.files.viewport}`)}" alt="${escape(`${run} ${result.surface}`)}">` : `<div class="empty">no image</div>`;
  const findings = result.findings?.length ? ` · ${result.findings.length} finding(s): ${result.findings.map(item => `${item.assertion}${item.enforced ? '!' : ''}`).join(', ')}` : '';
  const full = result.files?.full ? ` · <a href="${escape(`../${run}/${result.files.full}`)}">full</a>` : '';
  return `${image}<div class="status ${result.status === 'failed' ? 'failed' : ''}">${escape(result.status)}${escape(findings)}${full}${result.status === 'failed' && result.reason ? ` · ${escape(result.reason)}` : ''}</div>`;
}

function page(id, entry) {
  const meta = entry.meta;
  const refs = ARGUS ? (meta.argus ?? []).map(name => path.join(ARGUS, name)).filter(file => fs.existsSync(file)) : [];
  const surfaces = [...entry.cells.keys()].sort((a, b) => SURFACE_ORDER.indexOf(a) - SURFACE_ORDER.indexOf(b));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(id)}</title><style>${STYLE}</style></head><body>
  <h1>${escape(id)}</h1>
  <p class="meta">Area ${escape(meta.area)} · screen ${escape(meta.screen)} · ${escape(meta.title)}</p>
  ${refs.length ? `<div class="argus">${refs.map(file => `<figure><img src="${pathToFileURL(file).href}" alt=""><figcaption>ARGUS · ${escape(path.basename(file))}</figcaption></figure>`).join('')}</div>` : ''}
  <table><thead><tr><th>Surface</th><th>Before</th><th>After</th></tr></thead><tbody>
  ${surfaces.map(surface => `<tr><td class="surface">${escape(surface)}</td><td class="cell">${cell(entry.cells.get(surface).before, 'before')}</td><td class="cell">${cell(entry.cells.get(surface).after, 'after')}</td></tr>`).join('\n')}
  </tbody></table></body></html>`;
}

fs.mkdirSync(COMPARE, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  // Local files only.
  await context.route(url => url.protocol !== 'file:', route => route.abort());
  const tab = await context.newPage();
  for (const [id, entry] of scenarios) {
    const html = path.join(COMPARE, `${id}.html`);
    fs.writeFileSync(html, page(id, entry));
    await tab.goto(pathToFileURL(html).href);
    await tab.waitForLoadState('load');
    await tab.screenshot({ path: path.join(COMPARE, `${id}.png`), fullPage: true });
  }
  await context.close();
} finally {
  await browser.close();
}

const summary = (result) => result ? `${result.status}${result.findings?.length ? ` (${result.findings.length})` : ''}` : '—';
const rows = [...scenarios].map(([id, entry]) => {
  const cells = SURFACE_ORDER.filter(surface => entry.cells.has(surface)).map(surface => `${surface}: ${summary(entry.cells.get(surface).before)} → ${summary(entry.cells.get(surface).after)}`);
  return `<tr><td><a href="${escape(id)}.html">${escape(id)}</a></td><td>${escape(entry.meta.area)}</td><td>${escape(entry.meta.screen)}</td><td>${escape(entry.meta.title)}</td><td>${cells.map(escape).join('<br>')}</td><td><a href="${escape(id)}.png">png</a></td></tr>`;
});
fs.writeFileSync(path.join(COMPARE, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ANTARA parity</title><style>${STYLE} td { border-bottom: 1px solid #ffffff0d; }</style></head><body>
<h1>ANTARA · ARGUS parity</h1>
<p class="meta">Headless captures with mocked routes and a fixture wallet. Not funded acceptance, not a real Privy login, not a real passkey, Bluetooth or location ceremony.
Before: ${runs.before ? escape(JSON.stringify(runs.before.totals)) : 'none'} · After: ${runs.after ? escape(JSON.stringify(runs.after.totals)) : 'none'}</p>
<table><thead><tr><th>Scenario</th><th>Area</th><th>Screen</th><th>Shows</th><th>Status (before → after)</th><th>Sheet</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table></body></html>`);
console.log(`Wrote ${scenarios.size} comparison sheet(s) to ${path.relative(process.cwd(), COMPARE)}`);
