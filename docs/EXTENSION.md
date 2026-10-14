# ANTARA Chrome extension

The extension is the ANTARA wallet in Chrome's **side panel**. It mounts the same
wallet as the desktop app (`src/solares/WalletApp`), with Solana first and the same
five networks: Solana, Ethereum, BSC (BNB Smart Chain), Robinhood Chain and Base.
It uses the same Privy app as the desktop and the website, so a user signs in to
the same account and sees the same embedded-wallet addresses.

It is a standalone wallet (milestone M1). Websites cannot connect to it: it has no
content scripts and injects no wallet provider.

| | |
|---|---|
| Extension ID (unpacked and development) | `ckfkljfbjkmkjkkjkpbnmoehfipdcoin` |
| Origin to allow | `chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin` |
| Production API | `https://antara.tech` (the only host permission) |
| Development API | `http://localhost:8787` (`npm run dev:api`) |
| Minimum Chrome | 116 |

The ID is fixed by the public `key` in [`extension/extension-key.json`](../extension/extension-key.json),
so every unpacked load on any machine gets the same ID. The private signing key is
not in the repository. The Chrome Web Store assigns its own ID on first upload; that
procedure is in [`extension/EXTENSION_ID.md`](../extension/EXTENSION_ID.md).

## Build and load unpacked

Prerequisites: Node.js 22.12+, `npm ci`, and a `.env.local` with the public
`VITE_PRIVY_APP_ID` (see [`.env.example`](../.env.example)). Without it the
extension opens the disconnected wallet only.

```sh
npm run dev:api               # local API on http://localhost:8787 (separate terminal)
npm run build:extension:dev   # writes dist-extension/, named "ANTARA (dev)"
npm run check:extension       # manifest, permissions, CSP, remote code, secrets
```

Then, in your own Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `dist-extension` folder.
3. Check that the card shows the ID `ckfkljfbjkmkjkkjkpbnmoehfipdcoin`.
4. Pin ANTARA and click its toolbar icon. The wallet opens in the side panel.
5. Use **Open in full tab** at the top of the panel for the same wallet in a tab.
   Once the tab opens, the panel calls `window.close()` to close itself, so only one
   wallet page is signed in at a time. This has not yet been checked in a real
   Chrome side panel.

After a rebuild, click the reload icon on the extension card. The development build
reaches the local API through its `localhost:8787` host permission.

### Production build

```sh
npm run build:extension       # API https://antara.tech unless VITE_API_BASE is set
npm run package:extension     # Chrome Web Store ZIP in dist-extension-store/
```

`build:extension` typechecks, builds with `--mode extension`, then runs the
production check. `VITE_API_BASE` must be an https origin; a local or plain-http
API fails the build. Any API host other than `https://antara.tech` is reached
through CORS, so its `ALLOWED_ORIGINS` must list the extension origin.

Build values come from the shell, `.env` / `.env.local`, and the mode files
`.env.extension.local` / `.env.extension-dev.local`; shell values win. Only public
values may be used. The build fails on a secret-looking `VITE_` name, on an RPC URL
with credentials or a key in its path (`/v2/<key>`) or query, and on a malformed
`VITE_PRIVY_APP_ID`. `VITE_PRIVY_CLIENT_ID` is optional (below).

### Tests

```sh
npm run test:extension        # builds two hermetic variants, then runs Playwright
npm run test:extension:run    # reruns the tests on the existing test builds
```

The tests load the unpacked builds in an isolated, headless Playwright Chromium
profile (never your Chrome) and check:

- the documented ID;
- that the service worker has no message listeners and no storage;
- that the toolbar icon opens the side panel (no `default_popup`, panel behavior set);
- the disconnected wallet in the side panel and the tab, with no fabricated amounts;
- no horizontal overflow and no page scroll at panel widths;
- "Open in full tab";
- that frames and network requests stay on the committed allowlists.

One variant has no Privy app ID; the other uses a well-formed placeholder ID, so
`PrivyProvider` mounts and reaches `auth.privy.io` over CORS. Neither signs in.

## Origins to allow

Allow the origin `chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin` in each of
these places.

**Privy dashboard** (the same app as the desktop and website):

- Add the origin to the app's allowed origins.
- Optional: create an app client for the extension (Dashboard > Clients) with this
  origin, and build with its public ID in `VITE_PRIVY_CLIENT_ID`. `PrivyProvider`
  receives it as `clientId`. Put it in `.env.extension.local` (and
  `.env.extension-dev.local` for dev builds), not in the shared `.env.local`, which
  every build reads: a web or desktop build with the extension's client fails to log
  in. The desktop (`https://tauri.localhost`) and the website can use their own
  clients the same way, set in the shell for that build.
- Keep HttpOnly cookies off. Cookies tie the app to one verified domain.
- Turn bot protection (CAPTCHA) off for the client the extension uses. The Web Store
  forbids remotely hosted code, so the build replaces Turnstile and hCaptcha with stubs
  that fail closed. If CAPTCHA is on, login fails with "Captcha failed" after about
  20 seconds.
- Keep Telegram login off. Its widget script is remote and removed from the build.

**ANTARA API** (`ALLOWED_ORIGINS` on Render and in `server/.env`): list the
extension origin next to `https://antara.tech`, `https://www.antara.tech` and
`https://tauri.localhost`. The server default already includes it. The production
API also has a host permission, but a staging API host relies on this list.

**Alchemy and other RPC providers:** no Alchemy key ships in the extension. The
server's `ALCHEMY_API_KEY` stays on the server and needs no origin. The extension's
browser RPC calls use the pinned keyless endpoints listed in `CORS_ORIGINS` in
[`extension/policy.mjs`](../extension/policy.mjs), and the build refuses keyed RPC
URLs. If you later use an origin-restricted browser key with Alchemy (or Helius),
add the extension origin to that key's allowlist in the provider's dashboard. The
key must still pass the build's URL checks.

**WalletConnect (Reown):** if Privy uses your own WalletConnect project ID, add the
extension origin to that project's allowed domains.

## Limits

- **Login:** the email one-time code is designed for the side panel, which stays open
  while you read the email. A real Privy login in Chrome has **not** been verified yet. There is no popup, because a popup closes when it loses focus.
  Social login is off: it would need the `identity` permission and a
  `chromiumapp.org` redirect. Passkey login has not been tested in the extension.
- **External wallets:** expected to be WalletConnect only (not yet verified in Chrome). MetaMask, Phantom and other wallet
  extensions do not inject into `chrome-extension://` pages.
- **No dApp connection:** websites cannot request accounts or signatures from ANTARA.
  This stays off until Privy confirms in writing that its terms allow an embedded-wallet
  browser-extension provider.
- **One wallet page at a time:** the side panel and the full tab each run their own
  Privy session over the same login. Opening the tab from the panel asks Chrome to
  close the panel. Avoid keeping a second ANTARA tab open.
- **Activity is per device and per app:** transfer, route and vault references are
  stored in the page's `localStorage`. The extension shows what was started in the
  extension, not what was started in the desktop app.
- **Service worker:** it only sets the side-panel behavior. It holds no keys, tokens,
  sessions or wallet state, and accepts no messages.
- **Not yet done:** signing in with the real Privy app in Chrome, funded transfers
  and swaps from the extension, and a Chrome Web Store listing. Record that evidence
  in [VERIFICATION.md](VERIFICATION.md).

## Permissions and policy

- `permissions`: `sidePanel` only.
- `host_permissions`: `https://antara.tech/*`. Development builds add
  `http://localhost:8787/*` and `http://127.0.0.1:8787/*`.
- CSP: scripts only from the package, and frames only from `https://auth.privy.io`
  and WalletConnect Verify. There is no `'wasm-unsafe-eval'`.
- [`extension/policy.mjs`](../extension/policy.mjs) is the single source of these
  values. The build, `scripts/extension-check.mjs` and the tests all read it, and
  each fails when the manifest drifts from it.

Code map: `extension/` (manifest, policy, HTML entries), `src/extension/` (side
panel, tab, service worker, captcha stubs), `src/platform/` (runtime detection and
`openExternal`, which opens explorer links in a new browser tab),
`vite.extension.config.ts`, `scripts/extension-*.mjs` and `tests/extension/`.
