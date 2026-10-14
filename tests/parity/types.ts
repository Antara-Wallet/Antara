/**
 * Parity runner contract (docs/UI_ARGUS_PARITY.md section 10). Scenario modules
 * (tests/parity/scenarios/*.ts) and route modules (tests/parity/routes/*.ts) code
 * against these types only. Owned by Area A; other areas request changes in their
 * hand-off notes instead of editing this file.
 */
import type { BrowserContext, Locator, Page, Route } from '@playwright/test';

export type ParityRun = 'before' | 'after';
export const PARITY_RUN: ParityRun = process.env.PARITY_RUN === 'after' ? 'after' : 'before';
/** Port of the runner's own dev server. Defaults to the spec's 1426; override with PARITY_PORT when 1426 is taken. */
export const PARITY_PORT = Number(process.env.PARITY_PORT || 1426);
export const PARITY_ORIGIN = `http://127.0.0.1:${PARITY_PORT}`;
/** Fixed wall clock for every capture (page.clock.install). */
export const PARITY_TIME = new Date('2026-10-13T10:00:00Z');
/** Output root. `artifacts/` is git-ignored. */
export const PARITY_OUT = 'artifacts/ui-parity';

export type SurfaceId = 'desktop' | 'desktop-wide' | 'panel-360' | 'panel-420' | 'mobile';
export interface SurfaceSpec {
  id: SurfaceId;
  width: number;
  height: number;
  /** Rendered as the Chrome side panel: `?surface=sidepanel` (data-surface, extension.css, 30px bar replica). */
  sidepanel: boolean;
  /** Touch input (mobile only). */
  touch: boolean;
  /** At or below 640px: the narrow layout (bottom tabs, sheets). */
  narrow: boolean;
}
export const SURFACES: Readonly<Record<SurfaceId, SurfaceSpec>> = Object.freeze({
  desktop: { id: 'desktop', width: 1280, height: 800, sidepanel: false, touch: false, narrow: false },
  'desktop-wide': { id: 'desktop-wide', width: 1440, height: 900, sidepanel: false, touch: false, narrow: false },
  'panel-360': { id: 'panel-360', width: 360, height: 780, sidepanel: true, touch: false, narrow: true },
  'panel-420': { id: 'panel-420', width: 420, height: 860, sidepanel: true, touch: false, narrow: true },
  mobile: { id: 'mobile', width: 390, height: 844, sidepanel: false, touch: true, narrow: true },
});
/** Surfaces a scenario runs on when it does not list its own (spec 10.3). */
export const DEFAULT_SURFACES: readonly SurfaceId[] = ['desktop', 'mobile', 'panel-360'];

/** Wallet states the harness renders (`?state=`). `failed=<chain>` is the separate `failed` param. */
export type HarnessState = 'signed-out' | 'unconfigured' | 'signed-in' | 'evm-only';

/** The ARGUS-derived build areas of section 9. */
export type ParityArea = 'A' | 'B' | 'C' | 'D' | 'E';

export interface StepApi {
  page: Page;
  run: ParityRun;
  surface: SurfaceSpec;
  /**
   * Clicks the first visible element whose accessible name equals one of `names`.
   * Pass alternatives for names that change during the build, e.g. ['Receive', 'Deposit'].
   * When none appears within `timeout` (default 5s) the scenario is "not present":
   * skipped in the before run, a failure in the after run.
   */
  click(names: string | readonly string[], options?: { role?: Parameters<Page['getByRole']>[0]; exact?: boolean; within?: Locator; timeout?: number }): Promise<void>;
  /** Same "not present" rule for any locator that must become visible. */
  expectPresent(target: Locator, reason?: string, timeout?: number): Promise<void>;
  /** Waits for network idle, fonts and two animation frames. The runner also settles before and after steps. */
  settle(): Promise<void>;
}

/** Flags for the scenario-specific truth assertions of 10.4. Assertions 1, 3-7 and 9 run on every scenario. */
export interface TruthFlags {
  /** Assertion 2: no `data-station-state` other than `unknown`, and no On/Off/Active/Passed/Enforced in `vaultRegion`. Implied by vault profiles `layers-unavailable` and `not-provisioned`. */
  stationsUnknown?: boolean;
  /** Assertion 2: no station with `data-station-state="passed"`. */
  noPassed?: boolean;
  /** Assertion 2: no station with `data-station-state="failed"`. */
  noFailed?: boolean;
  /** Selector of the vault region for `stationsUnknown`. Default: the Wallet screen's account tab panel. */
  vaultRegion?: string;
  /** Assertion 8: with `webgl: false`, `img[src*="vault-still"]` is visible and the station list has 6 items. */
  webglFallback?: boolean;
}

export interface ParityScenario {
  /** Unique id from spec 10.3, e.g. 'home-signed-in'. Also the screenshot file name. */
  id: string;
  area: ParityArea;
  /** ANTARA screen number in spec section 6, e.g. '6.4'. */
  screen: string;
  /** One line describing what the capture shows. */
  title: string;
  /** ARGUS reference file names in the ARGUS_SHOTS folder (sheet.mjs shows them when ARGUS_REF_DIR is set). */
  argus: readonly string[];
  /** Surfaces to run on. Default DEFAULT_SURFACES. */
  surfaces?: readonly SurfaceId[];
  /** Page to load, relative to the server root. Default '/tests/parity/harness.html'. Any page must set `<html data-parity-ready="1">` once rendered. */
  path?: string;
  /** Harness wallet state. Default 'signed-in'. */
  state?: HarnessState;
  /** Extra query parameters, e.g. { failed: 'base' } or { balances: 'loading' }. */
  params?: Readonly<Record<string, string>>;
  /** Location hash without '#', e.g. 'swap' or 'vault'. */
  hash?: string;
  /** Route-module profiles, keyed by module: e.g. { vault: 'active', relay: 'config-500' }. */
  profile?: Readonly<Record<string, string>>;
  /** localStorage entries written before every page load (values are stored as given). */
  storage?: Readonly<Record<string, string>>;
  /** Default 'reduce'. Use 'no-preference' only for the planet motion pass. */
  reducedMotion?: 'reduce' | 'no-preference';
  /** false loads the page with `?webgl=0` (WebGL contexts return null). */
  webgl?: boolean;
  /** Interactions before the capture. */
  steps?: (api: StepApi) => Promise<void>;
  /** Also capture `<id>-full.png` with the main scroller unclamped when its content overflows. Default true. */
  full?: boolean;
  truth?: TruthFlags;
  /** Console errors (beyond the mocked 500/503 answers) this scenario expects. */
  allowConsole?: readonly RegExp[];
}

/** Collected by the routes; written to each result. */
export interface ParityNetworkLog {
  /** Same-origin /api requests no route module answered (answered 501). */
  unmocked: string[];
  /** Requests to any other origin, aborted. */
  blocked: string[];
  /** JSON-RPC methods with no fake (answered with a JSON-RPC error). */
  rpcUnmocked: string[];
}

/** A JSON-RPC override. Return `undefined` to let an earlier registration (or the base default) answer. */
export type RpcHandler = (params: unknown, context: { url: URL; method: string }) => unknown | undefined | Promise<unknown | undefined>;
export interface RpcRegistry {
  /** Solana JSON-RPC at https://rpc.parity.invalid. Later registrations win. */
  solana(method: string, handler: RpcHandler): void;
  /** EVM JSON-RPC at https://<network>.rpc.parity.invalid. Later registrations win. */
  evm(method: string, handler: RpcHandler): void;
}

export interface ParityRouteContext {
  run: ParityRun;
  origin: string;
  scenario: ParityScenario;
  surface: SurfaceSpec;
  /** `scenario.profile`, or {} */
  profile: Readonly<Record<string, string>>;
  rpc: RpcRegistry;
  log: ParityNetworkLog;
}

/**
 * A route module's entry point. Install `context.route(...)` handlers that answer
 * only what this module owns and call `route.fallback()` for everything else, so
 * earlier modules (and the base guard) still apply. Modules run in this order:
 * base, relay, vault, transfers (a later handler is consulted first).
 */
export type RouteInstaller = (context: BrowserContext, ctx: ParityRouteContext) => Promise<void>;

/** JSON helper for route modules: `fulfillJson(route, 200, body)`. */
export function fulfillJson(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** One truth-assertion outcome (10.4). `enforced: false` is a report-only annotation (before run, assertions 3-9). */
export interface Finding {
  assertion: number;
  name: string;
  enforced: boolean;
  details: string[];
}

/** One capture, written to artifacts/ui-parity/<run>/results/<surface>__<scenario>.json and folded into manifest.json. */
export interface ParityResult {
  run: string;
  id: string;
  area: string;
  screen: string;
  title: string;
  argus: readonly string[];
  surface: string;
  viewport: { width: number; height: number };
  url: string;
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  files: { viewport?: string; full?: string };
  webgl: 'available' | 'unavailable' | 'stubbed-off' | 'unknown';
  findings: Finding[];
  network: ParityNetworkLog;
  durationMs: number;
}
