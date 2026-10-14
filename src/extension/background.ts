// ANTARA MV3 service worker. It only configures the side panel. It holds no keys,
// tokens, sessions or wallet state, and listens for no messages: all Privy auth and
// signing happens inside extension pages that mount the wallet (side panel / tab).
type PanelChrome = {
  runtime: { onInstalled: { addListener: (fn: () => void) => void }; onStartup: { addListener: (fn: () => void) => void } };
  sidePanel?: { setPanelBehavior: (behavior: { openPanelOnActionClick: boolean }) => Promise<void> };
};

const api = (globalThis as unknown as { chrome: PanelChrome }).chrome;

function configureSidePanel() {
  // The manifest action has no default_popup, so this makes the toolbar icon open
  // the side panel directly. A popup would close on focus loss and break email OTP.
  api.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

api.runtime.onInstalled.addListener(configureSidePanel);
api.runtime.onStartup.addListener(configureSidePanel);
configureSidePanel();
