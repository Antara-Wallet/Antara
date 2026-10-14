# ANTARA Chrome extension ID

How to build, load and configure the extension: [docs/EXTENSION.md](../docs/EXTENSION.md).
This file records the ID, its key and the Web Store procedure.

| | |
|---|---|
| Extension ID | `ckfkljfbjkmkjkkjkpbnmoehfipdcoin` |
| Origin | `chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin` |
| Manifest `key` | the `key` value in [`extension-key.json`](./extension-key.json) (base64 DER SubjectPublicKeyInfo, public) |
| Status | **Development ID** for unpacked loads. The Chrome Web Store assigns its own ID (see below). |

The ID is `sha256(DER public key)`, first 32 hex digits mapped `0-f` to `a-p`. The
build writes the public key into `manifest.json`, so every unpacked load on any
machine gets this same ID.

## Private key

The matching RSA-2048 private key is **not in this repository**. It lives at
`%USERPROFILE%\.antara\extension-signing-key.pem` on the machine that created it.
Back it up privately (password manager or offline storage). Never commit it, paste
it into chat, or put it in CI logs.

- `npm run extension:key` prints the public key and ID (it never prints the private
  key). If no key exists it creates one, which produces a **different** ID.
- `npm run extension:key -- --check` confirms the local key matches `extension-key.json`.
- `npm run extension:key -- --public-key <base64>` prints the `{ id, key }` JSON for a
  public key copied from the Chrome Web Store dashboard (no private key involved).

## Chrome Web Store ID

Checked against the current Chrome docs on 2026-10-12
(developer.chrome.com/docs/extensions/reference/manifest/key): the documented way to
keep one ID is to take the **store's** public key, not to upload ours.

1. `npm run build:extension` (API `https://antara.tech` unless `VITE_API_BASE` is
   set; runs the production check), then `npm run package:extension`. The package step copies
   `dist-extension/`, removes `key` (and any `update_url`) from the manifest, re-runs
   `check:extension --store` and writes `dist-extension-store/antara-extension-<version>.zip`.
   Uploads with `key` in the manifest have been reported as rejected; the current
   docs do not say either way, so the package never includes it.
2. Upload that ZIP as a new item **without publishing**.
3. Package tab, **View public key**. Copy the text between the `BEGIN`/`END PUBLIC KEY`
   lines as one line, run `npm run extension:key -- --public-key <that text>`, and
   put the printed `id` and `key` into `extension/extension-key.json`.
4. Update the ID in the table above (the headless test compares them), rebuild,
   load unpacked and confirm the card shows the dashboard's Item ID.
5. Add the store origin `chrome-extension://<store id>` to Privy, to the API's
   `ALLOWED_ORIGINS` and to `ANTARA_LAYER_ORIGINS` (the passkey origins the vault
   layers accept, `server/.env.example`), as described in the next section. Without
   the last one, vault passkeys from the store extension are refused (closed).
6. Then remove the development origin from the **production** Privy allowed origins,
   `ALLOWED_ORIGINS` and `ANTARA_LAYER_ORIGINS`, and drop it from the production
   defaults in `server/src/config.ts` and `server/src/solares/layers/config.ts`.
   The development key is public (`extension-key.json`): any unpacked extension that
   copies it gets the same `chrome-extension://ckfk…` origin, so production must not
   keep trusting it once the store ID exists.

An extension origin never proves that a request came from ANTARA's code. Anyone can
load an unpacked extension with a copied public `key` (the development key, or the
store's public key) and get the same origin, and any native Windows program can ask
`webauthn.dll` for an `antara.tech` assertion with whatever origin it writes into
`clientDataJSON`. A vault passkey check therefore proves possession of the passkey
and the user's verification for that exact challenge, not which app or extension
asked (docs/VAULT_LAYERS.md §3).

Older guidance said to put the private key as `key.pem` in the first upload ZIP to
keep a self-generated ID. The current docs do not describe that path, so do not rely
on it; `check:extension` also rejects `.pem` files in a package.

## Settings that must allow this origin

1. **Privy dashboard** (same app as web/desktop, so users keep the same user ID and
   embedded wallets):
   - Add the extension origin to the allowed origins. Optionally create a dedicated
     **app client** for the extension with that origin and build with its public
     client ID in `VITE_PRIVY_CLIENT_ID` (passed to `PrivyProvider` as `clientId`).
   - Disable **bot protection / CAPTCHA** (Turnstile or hCaptcha) for the extension
     client. The extension build replaces both with fail-closed stubs because the
     Web Store forbids remotely hosted code. If CAPTCHA stays on, each stub logs
     `[ANTARA extension] Privy CAPTCHA ... is enabled for this app client but
     unsupported in the extension` to the console, and login fails with
     "Captcha failed" only after Privy's polling timeout (**up to about 20 s**).
     Privy's adblocker/VPN hint on that screen does not apply.
   - Keep **Telegram** login disabled. Its widget script is remote and is neutralised
     in the build.
   - Email OTP works in the side panel. External wallets: MetaMask and Phantom do
     not inject into `chrome-extension://` pages, so only WalletConnect can work there.
     Social OAuth is not enabled in M1 (it would need the `identity` permission and
     the `https://<id>.chromiumapp.org/` redirect).
2. **ANTARA API** (`server`): add the origin to `ALLOWED_ORIGINS` (comma-separated)
   wherever the API runs (Render dashboard / `server/.env`); the server default
   already lists it. The manifest's host permission covers only
   `https://antara.tech/*` (plus `localhost:8787` in development builds), so any
   other API host, such as a staging service, is reached through CORS and needs it.

## Permissions and network access

- `permissions`: exactly `sidePanel` and `geolocation` (`EXTENSION_PERMISSIONS` in
  [`policy.mjs`](./policy.mjs)); the check fails on anything missing or extra, and on
  any `optional_permissions` / `optional_host_permissions` key, even an empty one.
  `storage` is not requested because nothing uses `chrome.storage` (Privy and the
  wallet use the page's `localStorage`).
  - `geolocation` serves the paired-vault **Safe Zones** layer
    ([docs/VAULT_LAYERS.md](../docs/VAULT_LAYERS.md) §2e, owner decision O2). Without
    it `navigator.geolocation` fails immediately in extension pages. Chrome does not
    allow it as an optional permission, it skips the per-site prompt, and it adds the
    install warning **"Detect your physical location"**. The pages read a position
    only inside a vault-layer ceremony the user starts; the reading is device-reported
    and the server decides. Adding it before the first Web Store submission avoids a
    later update that Chrome would disable until users accept the new warning.
    `chrome.permissions.contains` reports it as granted, but
    `navigator.permissions.query({name: 'geolocation'})` still answers `prompt` in
    extension pages (headless Chromium, 2026-10-13), so code calls
    `getCurrentPosition` and handles its error instead of gating on that query. The
    headless tests also check that an ordinary web page in the same browser is denied.
- `minimum_chrome_version`: `122` (`MINIMUM_CHROME_VERSION`; the build target follows
  it). From Chrome 122 an extension page may use the WebAuthn RP ID of a site it has
  host permission for, so the vault **Biometrics** passkey (`rpId antara.tech`,
  `PASSKEY_RP_ID`) works from the extension; `clientDataJSON.origin` stays
  `chrome-extension://<id>`. The headless tests prove this with a virtual
  authenticator: `antara.tech` succeeds, `example.com` fails with `SecurityError`.
  If a user withdraws the extension's site access to `antara.tech`, passkey
  ceremonies are expected to fail, which keeps that layer closed. This is not
  verified yet: the headless test only shows that an RP ID with no host permission
  (`example.com`) is refused, so it is on the manual list (VAULT_LAYERS.md §15).
- Vault-layer ceremonies (passkey prompt, Web Bluetooth chooser, location) run in
  the full tab (`wallet.html#vault`), not in the side panel, until they are verified
  in the side panel on real Chrome (VAULT_LAYERS.md §15). The pages declare this as
  `<html data-layer-ceremony="tab|inline">`, set from `layerCapabilities()` in
  `src/platform/layers.ts`. Web Bluetooth needs no manifest permission; the chooser
  lists only nearby advertising BLE devices and never measures distance.
- `host_permissions`: `https://antara.tech/*` (ANTARA's production API, and the
  passkey RP ID claim above; the check fails without it) only;
  development builds (`ANTARA (dev)`) add `http://localhost:8787/*` and
  `http://127.0.0.1:8787/*`. The committed allowlists are `EXTENSION_HOST_PERMISSIONS`
  and `EXTENSION_DEV_HOST_PERMISSIONS` in [`policy.mjs`](./policy.mjs); the build and
  the check fail if the manifest differs, and a production build with a local host
  fails. Every third-party origin the pages call is listed in `CORS_ORIGINS` there
  and answered a CORS preflight from `chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin`
  on 2026-10-12 (Privy reflects the origin with credentials; the public RPCs answer
  `*` or reflect it). The headless tests fail on any request to an origin outside
  that list. A `VITE_*_RPC_URL` override never changes the manifest; it must be
  https, keyless and CORS-enabled.
- CSP (`extension_pages`): `script-src 'self'; object-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; frame-src https://auth.privy.io
  https://verify.walletconnect.org https://verify.walletconnect.com;`. No
  `'wasm-unsafe-eval'`; the check fails if WebAssembly compilation appears.

## Build, test and load unpacked

```sh
npm run build:extension:dev                 # API defaults to http://localhost:8787 (dev only)
npm run build:extension                     # production: API https://antara.tech unless VITE_API_BASE (https) is set
npm run check:extension                     # manifest, permissions, CSP, remote code, secrets
npm run test:extension                      # builds two hermetic variants and tests them headless
npm run package:extension                   # store ZIP from a production build (no "key")
```

`test:extension` builds `dist-extension-test/unconfigured` (no Privy app ID) and
`dist-extension-test/privy` (placeholder ID `cm0000000000000000000test`, so
PrivyProvider mounts and calls auth.privy.io). Those builds read no `.env` files and
no `VITE_` shell variables. `test:extension:run` reruns the tests on existing builds
and fails if they are missing.

Public build values come from the shell, `.env` / `.env.local`, and the mode files
`.env.extension.local` / `.env.extension-dev.local` (git-ignored); shell values win. Only public `VITE_` values are allowed:
the build fails on any `VITE_` name containing KEY, TOKEN, SECRET and similar
(unless allowlisted in `PUBLIC_ENV_NAMES`), on URLs with credentials, key-like path
segments (`/v2/<key>`) or credential query parameters, and on a malformed
`VITE_PRIVY_APP_ID`. A render failure shows "Wallet failed to start" instead of a
blank panel.

Chrome: open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked**, select `dist-extension/`. The card must show the ID above.
Click the toolbar icon: the wallet opens in the side panel (there is no popup).
**Open in full tab** at the top of the panel shows the same wallet in a tab.
