/**
 * The truth assertions of docs/UI_ARGUS_PARITY.md 10.4, run on every capture.
 * Assertions 1 and 2 are enforced in both runs. In the before run (PARITY_RUN=before)
 * 3-9 are report-only annotations, because today's UI fails some on purpose.
 *
 * Markup conventions the checks read (for every area's new components):
 * - `data-station-state="<visual>"` on each planet station item (7.3);
 * - `data-asset-row="token|receive|send"` plus `data-chain="<network key>"` on asset rows (assertion 3);
 * - `.ui-eyebrow` for the only text allowed at 10px (assertion 4);
 * - `.ui-btn-primary`, `.ui-card`, `.ui-sheet` from src/solares/ui/ui.css (assertions 5, 6);
 * - `data-parity-ignore` on harness-only chrome (the side-panel bar replica).
 */
import type { Page } from '@playwright/test';
import { NEVER_CLAIM } from '../../src/solares/layers/claims';
import type { Finding, ParityRun, ParityScenario, SurfaceSpec } from './types';

export type { Finding };


/**
 * 10.4 (1): a change pill or a non-USD currency, and the ARGUS claims (anchored so ANTARA's honest
 * "not protected by" copy passes). Owner decision 2026-10-13: balances are valued in US dollars at
 * Relay prices, so a dollar figure is allowed, but only marked as an estimate ("≈ $8.43", "< $0.01")
 * or as an exact "$0.00" (UNMARKED_USD).
 */
export const FIAT_OR_CHANGE = /\+\d+(\.\d+)?%|[€£¥]\s?\d/;
export const UNMARKED_USD = /(?<![≈<]\s?)\$(?!0\.00\b)\d/;
export const ARGUS_CLAIMS = /\bProtected by (ANTARA|ARGUS)\b|Transaction Secured|All security checks passed|untraceable|zero-knowledge|\bZK\b/i;
const FORBIDDEN: readonly RegExp[] = [...NEVER_CLAIM, FIAT_OR_CHANGE, UNMARKED_USD, ARGUS_CLAIMS];
/** 10.4 (2): status words that must not appear in the vault region when layer status is unknown. */
const STATUS_WORDS = /\b(On|Off|Active|Passed|Enforced)\b/;
const NETWORK_NAMES = /^(Solana|Solana devnet|Ethereum|BNB Smart Chain|Robinhood Chain|Base)\b/;
/** Mocked failures only; anything else (including aborted external requests) is a finding. */
const ALLOWED_CONSOLE = /status of (500|503)\b/;

interface PageFacts {
  text: string;
  vaultRegionText: string | null;
  stations: string[];
  selects: { label: string; options: string[] }[];
  assetRows: { kind: string; chain: string }[];
  legacyTokenNetworks: string[];
  smallText: { size: number; eyebrow: boolean; text: string; where: string }[];
  scrollWidth: number;
  innerWidth: number;
  primaries: { background: string; where: string }[];
  gradientButtons: { image: string; where: string }[];
  surfaces: { where: string; color: string; stops: string[] }[];
  blueFills: { where: string; color: string; width: number; height: number }[];
  animations: { where: string; name: string }[];
  canvases: { motion: string | null; rotation: string | null }[];
  stillVisible: boolean;
  stationItems: number;
}

/** Reads everything the checks need in one pass inside the page. */
async function readFacts(page: Page, vaultRegion: string): Promise<PageFacts> {
  return page.evaluate((vaultSelector) => {
    const ignored = (element: Element) => !!element.closest('[data-parity-ignore]');
    const where = (element: Element) => {
      const name = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.classList.length ? `.${[...node.classList].slice(0, 3).join('.')}` : ''}`;
      return element.parentElement ? `${name(element.parentElement)} > ${name(element)}` : name(element);
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const rgba = (value: string) => {
      const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
      if (!match) return null;
      const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
    };
    const colorsIn = (image: string) => image.match(/rgba?\([^)]*\)/g) ?? [];

    const all = [...document.body.querySelectorAll('*')].filter(element => !ignored(element));
    const smallText: PageFacts['smallText'] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || ignored(parent) || !visible(parent)) continue;
      const size = parseFloat(getComputedStyle(parent).fontSize);
      if (size < 11) smallText.push({ size, eyebrow: !!parent.closest('.ui-eyebrow'), text: node.textContent.trim().slice(0, 40), where: where(parent) });
    }
    const selects = [...document.querySelectorAll('select')].filter(visible).map(select => ({
      label: select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || select.id || 'select',
      // A disabled, empty-valued placeholder ("Select your wallet") is a prompt, not a network choice.
      options: [...select.options].filter(option => !(option.disabled && option.value === '')).map(option => option.text.trim()),
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const gradientButtons = buttons.flatMap(button => {
      const image = getComputedStyle(button).backgroundImage;
      if (!image.includes('gradient')) return [];
      const cobalt = colorsIn(image).map(rgba).some(color => !!color && color.a > 0.15 && color.b - color.r > 60);
      return cobalt ? [{ image: image.slice(0, 160), where: where(button) }] : [];
    });
    const surfaces = [...document.querySelectorAll('.desktop-app, .ui-sheet, .mobile-tabbar, .ui-card')].filter(visible).map(element => {
      const style = getComputedStyle(element);
      return { where: where(element), color: style.backgroundColor, stops: colorsIn(style.backgroundImage) };
    });
    const blueFills = all.filter(element => {
      if (element.closest('[role="switch"]')) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 64 || rect.height < 64 || !visible(element)) return false;
      const color = rgba(getComputedStyle(element).backgroundColor);
      return !!color && color.a >= 0.5 && color.b - color.r > 60 && color.b > 90;
    }).map(element => {
      const rect = element.getBoundingClientRect();
      return { where: where(element), color: getComputedStyle(element).backgroundColor, width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const animations: PageFacts['animations'] = [];
    for (const element of all) {
      if (!element.getClientRects().length) continue;
      for (const pseudo of [null, '::before', '::after'] as const) {
        const name = getComputedStyle(element, pseudo).animationName;
        if (name && name !== 'none') animations.push({ where: `${where(element)}${pseudo ?? ''}`, name });
      }
    }
    const region = document.querySelector(vaultSelector) as HTMLElement | null;
    const stationList = document.querySelector('[data-station-state]')?.closest('ul, ol');
    return {
      text: document.body.innerText,
      vaultRegionText: region ? region.innerText : null,
      stations: [...document.querySelectorAll('[data-station-state]')].map(element => element.getAttribute('data-station-state') ?? ''),
      selects,
      assetRows: [...document.querySelectorAll('[data-asset-row]')].filter(visible).map(element => ({ kind: element.getAttribute('data-asset-row') ?? '', chain: element.getAttribute('data-chain') ?? '' })),
      legacyTokenNetworks: [...document.querySelectorAll('.desktop-token-table tbody tr')].filter(visible).map(row => (row.querySelectorAll('td')[1]?.textContent ?? row.textContent ?? '').trim()),
      smallText,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      primaries: [...document.querySelectorAll('.ui-btn-primary')].filter(visible).map(element => ({ background: getComputedStyle(element).backgroundColor, where: where(element) })),
      gradientButtons,
      surfaces,
      blueFills,
      animations,
      canvases: [...document.querySelectorAll('canvas[data-motion]')].map(canvas => ({ motion: canvas.getAttribute('data-motion'), rotation: canvas.getAttribute('data-rotation') })),
      stillVisible: [...document.querySelectorAll('img[src*="vault-still"]')].some(visible),
      stationItems: stationList ? stationList.querySelectorAll(':scope > li').length : 0,
    };
  }, vaultRegion);
}

function parse(value: string) {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}
function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** A dark neutral surface: channel spread at most 14 and relative luminance below 0.08 (transparent passes). */
function neutralDark(value: string) {
  const color = parse(value);
  if (!color || color.a === 0) return true;
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 14 && luminance(color) < 0.08;
}

export async function checkTruth(page: Page, input: {
  run: ParityRun; scenario: ParityScenario; surface: SurfaceSpec; consoleErrors: string[]; pageErrors: string[];
}): Promise<Finding[]> {
  const { run, scenario, surface } = input;
  const truth = scenario.truth ?? {};
  const vaultProfile = scenario.profile?.vault;
  const stationsUnknown = truth.stationsUnknown ?? (vaultProfile === 'layers-unavailable' || vaultProfile === 'not-provisioned');
  const facts = await readFacts(page, truth.vaultRegion ?? '#wallet-account-panel');
  const reportOnly = run === 'before';
  const findings: Finding[] = [];
  const add = (assertion: number, name: string, details: string[], enforced = !reportOnly) => {
    if (details.length) findings.push({ assertion, name, enforced, details: details.slice(0, 25) });
  };

  // 1. No forbidden claims (enforced in both runs).
  add(1, 'forbidden claims', FORBIDDEN.flatMap(pattern => {
    const match = facts.text.match(pattern);
    return match ? [`${pattern} matched "${match[0]}"`] : [];
  }), true);

  // 2. Layer status only when the server answered (enforced in both runs).
  const two: string[] = [];
  if (stationsUnknown) {
    const known = facts.stations.filter(value => value !== 'unknown');
    if (known.length) two.push(`stations not unknown: ${known.join(', ')}`);
    const word = facts.vaultRegionText?.match(STATUS_WORDS);
    if (word) two.push(`vault region shows "${word[0]}"`);
  }
  if (truth.noPassed && facts.stations.includes('passed')) two.push('a station is passed');
  if (truth.noFailed && facts.stations.includes('failed')) two.push('a station is failed');
  add(2, 'layer status without a server answer', two, true);

  // 3. Solana first.
  const three: string[] = [];
  for (const select of facts.selects) {
    if (!select.options.some(option => NETWORK_NAMES.test(option))) continue;
    if (!/^(All networks|Solana)\b/.test(select.options[0] ?? '')) three.push(`select "${select.label}" starts with "${select.options[0]}"`);
  }
  for (const kind of new Set(facts.assetRows.map(row => row.kind))) {
    const rows = facts.assetRows.filter(row => row.kind === kind);
    if (rows.some(row => row.chain === 'solana') && rows[0].chain !== 'solana') three.push(`first ${kind} row is ${rows[0].chain}`);
  }
  if (facts.legacyTokenNetworks.some(name => name.startsWith('Solana')) && !facts.legacyTokenNetworks[0].startsWith('Solana')) three.push(`first token row is on ${facts.legacyTokenNetworks[0]}`);
  add(3, 'Solana first', three);

  // 4. Text size and horizontal overflow.
  const four = facts.smallText
    .filter(item => item.size < 10 || !item.eyebrow)
    .map(item => `${item.size}px "${item.text}" (${item.where})`);
  if (surface.narrow && facts.scrollWidth > facts.innerWidth) four.push(`horizontal scroll: scrollWidth ${facts.scrollWidth} > innerWidth ${facts.innerWidth}`);
  add(4, 'text size and overflow', four);

  // 5. Primary buttons: ice only; no cobalt gradient on any button.
  add(5, 'primary buttons', [
    ...facts.primaries.filter(item => item.background !== 'rgb(195, 213, 241)').map(item => `.ui-btn-primary is ${item.background} (${item.where})`),
    ...facts.gradientButtons.map(item => `cobalt gradient on ${item.where}: ${item.image}`),
  ]);

  // 6. No all-blue background.
  add(6, 'no all-blue background', [
    ...facts.surfaces.flatMap(item => [item.color, ...item.stops.filter(stop => (parse(stop)?.a ?? 0) >= 0.25)]
      .filter(color => !neutralDark(color)).map(color => `${item.where} uses ${color}`)),
    ...facts.blueFills.map(item => `blue fill ${item.color} on ${item.where} (${item.width}×${item.height})`),
  ]);

  // 7. Motion under reduced motion.
  const seven: string[] = [];
  if ((scenario.reducedMotion ?? 'reduce') === 'reduce') {
    seven.push(...facts.animations.map(item => `animation "${item.name}" on ${item.where}`));
    for (const canvas of facts.canvases) if (canvas.motion !== 'still') seven.push(`planet canvas data-motion="${canvas.motion}"`);
    if (facts.canvases.some(canvas => canvas.rotation !== null)) {
      await page.waitForTimeout(1_000);
      const later = await page.evaluate(() => [...document.querySelectorAll('canvas[data-motion]')].map(canvas => canvas.getAttribute('data-rotation')));
      facts.canvases.forEach((canvas, index) => { if (canvas.rotation !== later[index]) seven.push(`planet rotation changed: ${canvas.rotation} → ${later[index]}`); });
    }
  }
  add(7, 'reduced motion', seven);

  // 8. WebGL fallback.
  if (truth.webglFallback) {
    const eight: string[] = [];
    if (!facts.stillVisible) eight.push('img[src*="vault-still"] is not visible');
    if (facts.stationItems !== 6) eight.push(`station list has ${facts.stationItems} items, expected 6`);
    add(8, 'WebGL fallback', eight);
  }

  // 9. Console.
  const allowed = [ALLOWED_CONSOLE, ...(scenario.allowConsole ?? [])];
  add(9, 'console', [
    ...input.pageErrors.map(message => `pageerror: ${message}`),
    ...input.consoleErrors.filter(message => !allowed.some(pattern => pattern.test(message))).map(message => `console.error: ${message.slice(0, 200)}`),
  ]);
  return findings;
}
