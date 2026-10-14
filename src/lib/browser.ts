import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Bridge to the embedded multi-tab browser. Each tab is its own native child
 * webview (managed in Rust via async commands to avoid the Windows add_child
 * deadlock); only the active tab is shown. Remote pages have no Tauri IPC →
 * sandboxed from the vault.
 */

export const browserOpen = (
  id: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number
) => invoke<void>("browser_open", { id, url, x, y, width, height });

export const browserActivate = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number
) => invoke<void>("browser_activate", { id, x, y, width, height });

export const browserNavigate = (id: string, url: string) =>
  invoke<void>("browser_navigate", { id, url });

export const browserClose = (id: string) => invoke<void>("browser_close", { id });
export const browserHideAll = () => invoke<void>("browser_hide_all");
export const browserBack = (id: string) => invoke<void>("browser_back", { id });
export const browserForward = (id: string) => invoke<void>("browser_forward", { id });
export const browserReload = (id: string) => invoke<void>("browser_reload", { id });

export interface BrowserNavEvent {
  id: string;
  url: string;
}

/** Fires whenever any tab navigates (carries the tab id + new url). */
export const onBrowserNavigated = (cb: (e: BrowserNavEvent) => void): Promise<UnlistenFn> =>
  listen<BrowserNavEvent>("browser:navigated", (e) => cb(e.payload));
