// Runtime detection and small platform helpers shared by the desktop (Tauri),
// browser and Chrome extension builds. Nothing here holds keys, tokens or wallet
// state; it only answers "where am I running" and opens links the right way.

export type Runtime = 'tauri' | 'extension' | 'web';
export type ExtensionSurface = 'sidepanel' | 'popup' | 'tab';

/** The subset of the Chrome extension API the shared app may use. */
type ChromeExtensionApi = {
  runtime?: { id?: string; getURL?: (path: string) => string };
  tabs?: { create?: (options: { url: string; active?: boolean }) => Promise<unknown> };
};

function chromeApi(): ChromeExtensionApi | undefined {
  return (globalThis as { chrome?: ChromeExtensionApi }).chrome;
}

function hasTauri(): boolean {
  // Same signal @tauri-apps/api/core isTauri() reads, without importing Tauri here.
  return typeof globalThis !== 'undefined' && !!(globalThis as { isTauri?: unknown }).isTauri;
}

/** True only inside one of this extension's own pages (side panel, popup, tab). */
export function isExtension(): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'chrome-extension:') return false;
  const id = chromeApi()?.runtime?.id;
  return !!id && location.host === id;
}

export function isTauri(): boolean {
  return hasTauri();
}

export function detectRuntime(): Runtime {
  if (hasTauri()) return 'tauri';
  if (isExtension()) return 'extension';
  return 'web';
}

/** Which extension page is rendering, declared by each entry's <html data-surface>. */
export function extensionSurface(): ExtensionSurface | null {
  if (!isExtension() || typeof document === 'undefined') return null;
  const surface = document.documentElement.dataset.surface;
  return surface === 'sidepanel' || surface === 'popup' || surface === 'tab' ? surface : null;
}

/** Absolute URL of a page bundled with the extension, or null outside it. */
export function extensionUrl(path: string): string | null {
  if (!isExtension()) return null;
  return chromeApi()?.runtime?.getURL?.(path.replace(/^\/+/, '')) ?? null;
}

/**
 * Only plain web links leave the app. javascript:, data:, file:, chrome: and
 * relative URLs are refused so a crafted link cannot run code or open internals.
 */
export function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Open an external web URL outside the wallet surface:
 * - extension: a new browser tab (chrome.tabs.create needs no "tabs" permission)
 * - desktop: the system browser through the Tauri opener plugin
 * - web: a new tab with no opener relationship
 */
export async function openExternal(url: string): Promise<void> {
  const href = safeExternalUrl(url);
  if (!href) throw new Error('Only http(s) links can be opened.');
  const runtime = detectRuntime();
  if (runtime === 'extension') {
    const create = chromeApi()?.tabs?.create;
    if (create) { await create({ url: href, active: true }); return; }
  }
  if (runtime === 'tauri') {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}
