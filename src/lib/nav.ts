// Minimal client-side router + external-link helper shared by the landing site.
// The public site and the app share one SPA; /docs renders the docs page,
// everything else renders the app.
import { openExternal as openPlatformExternal } from "../platform";

/** Navigate to an in-app path (e.g. "/docs" or "/") without a full reload. */
export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Open a link. Same-origin paths ("/docs", the default for unset community and
 * download links) navigate inside the app; http(s) URLs leave it through the
 * platform helper (system browser on desktop, a browser tab in the extension, a
 * no-opener tab on the web). Anything else is refused.
 */
export function openExternal(url: string) {
  if (/^\/(?!\/)/.test(url)) {
    navigate(url);
    return;
  }
  openPlatformExternal(url).catch((error) => {
    console.warn("[ANTARA] Could not open the link:", error instanceof Error ? error.message : error);
  });
}

/** Reads one build-time value. Outside Vite (Node unit tests) import.meta.env is undefined. */
function readEnv(get: () => string | undefined): string | undefined {
  try { return get(); } catch { return undefined; }
}

export const X_PROFILE_URL = readEnv(() => import.meta.env.VITE_COMMUNITY_URL) ?? "/docs";
// The public download page: the Windows installer and the Chrome extension zip, listed in
// public/downloads/manifest.json. VITE_DESKTOP_DOWNLOAD_URL can still point elsewhere.
export const DOWNLOAD_URL = readEnv(() => import.meta.env.VITE_DESKTOP_DOWNLOAD_URL) ?? "/download";
