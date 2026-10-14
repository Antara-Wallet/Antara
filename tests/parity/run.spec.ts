/**
 * Parity runner (docs/UI_ARGUS_PARITY.md 10.2). For every scenario × surface:
 * fresh headless context → routes → page → steps → truth assertions (10.4) → screenshot.
 *
 *   $env:PARITY_RUN='before'; npx.cmd playwright test -c playwright.parity.config.ts
 *   $env:PARITY_RUN='after';  npx.cmd playwright test -c playwright.parity.config.ts
 *   ... -g "home-"            one area or scenario (titles are "<surface> › <scenario id>")
 *
 * Output (git-ignored): artifacts/ui-parity/<run>/<surface>/<scenario>[-full].png, one
 * results/<surface>__<scenario>.json per capture, and <run>/manifest.json (teardown.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';
import { scenarios, surfacesFor } from './manifest';
import { checkTruth } from './truth';
import { createRpcRegistry, install as base } from './routes/base';
import { install as relay } from './routes/relay';
import { install as vault } from './routes/vault';
import { install as transfers } from './routes/transfers';
import {
  PARITY_ORIGIN, PARITY_OUT, PARITY_RUN, PARITY_TIME, SURFACES,
  type ParityNetworkLog, type ParityResult, type ParityRouteContext, type ParityScenario, type StepApi, type SurfaceSpec,
} from './types';

/** Installed in this order; a later module is consulted first and falls back to earlier ones. */
const ROUTE_MODULES = [base, relay, vault, transfers];

class NotPresent extends Error {}


function urlFor(scenario: ParityScenario, surface: SurfaceSpec) {
  const query = new URLSearchParams({ state: scenario.state ?? 'signed-in', ...(scenario.params ?? {}) });
  if (surface.sidepanel) query.set('surface', 'sidepanel');
  if (scenario.webgl === false) query.set('webgl', '0');
  return `${scenario.path ?? '/tests/parity/harness.html'}?${query}${scenario.hash ? `#${scenario.hash}` : ''}`;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  // Lazy screens show "Loading workspace…" in a Suspense fallback; wait it out (best effort).
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(element => /Loading workspace/.test(element.textContent ?? '')), null, { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Decode every <img> and CSS background image in use, so art never paints half-way through a capture.
    const urls = new Set<string>();
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        for (const match of getComputedStyle(element, pseudo).backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)) urls.add(match[1]);
      }
    }
    const images = [...document.images, ...[...urls].map(src => Object.assign(new Image(), { src }))];
    await Promise.all(images.map(image => image.decode().catch(() => undefined)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function stepApi(page: Page, surface: SurfaceSpec): StepApi {
  return {
    page,
    run: PARITY_RUN,
    surface,
    settle: () => settle(page),
    async click(names, options = {}) {
      const list = typeof names === 'string' ? [names] : names;
      const root = options.within ?? page;
      const role = options.role ?? 'button';
      const deadline = Date.now() + (options.timeout ?? 5_000);
      do {
        for (const name of list) {
          const candidates = root.getByRole(role, { name, exact: options.exact ?? true });
          for (const candidate of await candidates.all()) {
            if (await candidate.isVisible()) { await candidate.click(); return; }
          }
        }
        await page.waitForTimeout(150);
      } while (Date.now() < deadline);
      throw new NotPresent(`No visible ${role} named ${list.map(name => `"${name}"`).join(' or ')}`);
    },
    async expectPresent(target: Locator, reason = 'target', timeout = 5_000) {
      const shown = await target.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
      if (!shown) throw new NotPresent(`${reason} did not appear`);
    },
  };
}

/**
 * Captures the full content as `<id>-full.png` when it overflows: the document itself, or
 * the shell's main scroller (the shell clips to 100dvh and scrolls `.desktop-content`;
 * new scrollers opt in with `data-parity-scroll`). Returns false when nothing overflows.
 */
async function captureFull(page: Page, file: string) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollHeight > window.innerHeight + 4,
    inner: [...document.querySelectorAll<HTMLElement>('.desktop-content, [data-parity-scroll]')].some(element => element.scrollHeight > element.clientHeight + 4),
  }));
  if (!overflow.inner) {
    if (!overflow.document) return false;
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    return true;
  }
  const style = await page.addStyleTag({ content: `
    html, body, #root { height: auto !important; overflow: visible !important; }
    .desktop-app { height: auto !important; min-height: 100vh !important; overflow: visible !important; }
    .desktop-main, .desktop-body, .desktop-content, [data-parity-scroll] { height: auto !important; max-height: none !important; overflow: visible !important; }
  ` });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  await style.evaluate(element => (element as HTMLElement).remove());
  return true;
}

function writeResult(result: ParityResult) {
  const dir = path.join(PARITY_OUT, PARITY_RUN, 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${result.surface}__${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

for (const scenario of scenarios) {
  for (const surfaceId of surfacesFor(scenario)) {
    const surface = SURFACES[surfaceId];
    test(`${surfaceId} › ${scenario.id}`, async ({ browser }) => {
      const started = Date.now();
      const log: ParityNetworkLog = { unmocked: [], blocked: [], rpcUnmocked: [] };
      const url = urlFor(scenario, surface);
      const result: ParityResult = {
        run: PARITY_RUN, id: scenario.id, area: scenario.area, screen: scenario.screen, title: scenario.title, argus: scenario.argus,
        surface: surfaceId, viewport: { width: surface.width, height: surface.height }, url, status: 'failed',
        files: {}, webgl: 'unknown', findings: [], network: log, durationMs: 0,
      };
      const context = await browser.newContext({
        baseURL: PARITY_ORIGIN,
        viewport: { width: surface.width, height: surface.height },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'UTC',
        reducedMotion: scenario.reducedMotion ?? 'reduce',
        hasTouch: surface.touch,
        serviceWorkers: 'block',
      });
      let skipReason = '';
      try {
        const ctx: ParityRouteContext = { run: PARITY_RUN, origin: PARITY_ORIGIN, scenario, surface, profile: scenario.profile ?? {}, rpc: createRpcRegistry(), log };
        for (const install of ROUTE_MODULES) await install(context, ctx);
        if (scenario.storage) {
          await context.addInitScript(entries => {
            for (const [key, value] of Object.entries(entries)) { try { localStorage.setItem(key, value); } catch { /* storage blocked: the screen shows its own state */ } }
          }, scenario.storage);
        }
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.clock.install({ time: PARITY_TIME });
        await page.goto(url);
        await page.waitForFunction(() => document.documentElement.dataset.parityReady === '1', null, { timeout: 30_000 });
        result.webgl = scenario.webgl === false ? 'stubbed-off' : await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          return canvas.getContext('webgl2') || canvas.getContext('webgl') ? 'available' as const : 'unavailable' as const;
        });
        await settle(page);
        try {
          await scenario.steps?.(stepApi(page, surface));
        } catch (error) {
          if (!(error instanceof NotPresent)) throw error;
          if (PARITY_RUN === 'after') throw new Error(`Screen not present in the after run: ${error.message}`);
          skipReason = `not present before: ${error.message}`;
          result.status = 'skipped';
          result.reason = skipReason;
        }
        if (!skipReason) {
          await settle(page);
          result.findings = await checkTruth(page, { run: PARITY_RUN, scenario, surface, consoleErrors, pageErrors });
          const runDir = path.join(PARITY_OUT, PARITY_RUN);
          const dir = path.join(runDir, surfaceId);
          fs.mkdirSync(dir, { recursive: true });
          const shot = path.join(dir, `${scenario.id}.png`);
          await page.screenshot({ path: shot, animations: 'disabled' });
          result.files.viewport = path.relative(runDir, shot).split(path.sep).join('/');
          if (scenario.full !== false) {
            const full = path.join(dir, `${scenario.id}-full.png`);
            if (await captureFull(page, full)) result.files.full = path.relative(runDir, full).split(path.sep).join('/');
          }
          for (const finding of result.findings) {
            test.info().annotations.push({ type: finding.enforced ? 'truth-failure' : 'finding', description: `${finding.assertion}. ${finding.name}: ${finding.details.join(' | ')}` });
          }
          const failures = result.findings.filter(finding => finding.enforced);
          result.status = failures.length ? 'failed' : 'captured';
          if (failures.length) result.reason = failures.map(finding => `${finding.assertion}. ${finding.name}`).join(', ');
        }
      } catch (error) {
        result.status = 'failed';
        result.reason ??= error instanceof Error ? error.message.split('\n')[0] : String(error);
        throw error;
      } finally {
        result.durationMs = Date.now() - started;
        writeResult(result);
        await context.close();
      }
      test.skip(!!skipReason, skipReason);
      if (result.status === 'failed') {
        throw new Error(`Truth assertions failed:\n${result.findings.filter(finding => finding.enforced).map(finding => `${finding.assertion}. ${finding.name}: ${finding.details.join(' | ')}`).join('\n')}`);
      }
    });
  }
}
