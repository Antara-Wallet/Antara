# ANTARA desktop

ANTARA is a Windows desktop wallet built with Tauri 2, Rust, and the system WebView2 runtime. Its React interface is rendered inside the native window. The Vite URL is only the development asset server; users of a packaged build do not need to open a browser or install Node.js.

On another computer, start with [the laptop setup guide](LAPTOP_SETUP.md) and
[the project handoff](HANDOFF.md). Use `npm.cmd` in Windows PowerShell to avoid
the blocked `npm.ps1` execution-policy issue without changing system policy.

## Run the native application

From the repository root:

```powershell
npm.cmd ci
npm.cmd --prefix server ci
npm.cmd run desktop:dev
```

`npm run tauri dev` is equivalent. Tauri runs `scripts/desktop-services.mjs`, which starts the local API on port 8787 and Vite on port 1420. Existing ANTARA development services are reused. The helper terminates only processes it started; it does not stop an existing server that belongs to another terminal.

The development window loads `http://localhost:1420`. Its main window is labelled `main`, titled ANTARA, starts at 1440 × 960, and uses the system's native window controls. Frontend changes reload inside this window.

Windows prerequisites are Node.js 22.12+, Rust with the MSVC toolchain, Microsoft C++ Build Tools, and Microsoft Edge WebView2. The NSIS installer can install WebView2 when absent. See [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

### Local development on macOS

The desktop development window also builds on macOS with Rust and Xcode Command Line Tools. Use the repository's `.nvmrc` to select Node 24, matching the web CI runtime:

```sh
nvm use
npm ci
npm --prefix server ci
npm run desktop:dev
```

The launcher starts or reuses the API at `http://localhost:8787` and the frontend at `http://localhost:1420`. Open `/` for the public landing, `/app` for the browser wallet, and `/docs` for the guide. The native window opens the wallet directly.

Create `.env.local` and `server/.env` from their examples only when those files do not already exist. A fresh clone does not contain the ignored credentials mentioned in historical setup notes. With blank credentials, the app runs disconnected; authenticated balances, signing, and Relay routes require later configuration.

The legacy native Windows WebAuthn bridge, Bluetooth presence, and Windows location commands return explicit unsupported errors on macOS. They do not provide protection for Privy wallets. The local encrypted vault, USB enumeration, and native browser remain compiled into the desktop app; the vault's signing, key-reveal and import commands, native WebAuthn and drive listing are compiled but not granted to any webview (see [Native command access](#native-command-access)). Packaging is still configured for the Windows NSIS installer; a macOS signed release and authenticated wallet acceptance are separate work.

## Configuration

Copy `.env.example` to `.env.local` for public frontend settings. Copy `server/.env.example` to `server/.env` for local API secrets. Existing environment files are never overwritten by the launcher.

For local development, leave `VITE_API_BASE` empty: Vite forwards `/api` requests to the local API. Configure the Privy app ID in the frontend and the matching app ID and app secret on the API. Relay's key stays on the API. RPC settings and the full custody model are described in [SECURITY.md](./SECURITY.md).

For a packaged desktop build, `VITE_API_BASE` must be the deployed **HTTPS** API origin. The production value is `https://antara.tech` (`www.antara.tech` redirects to it). The packaged window is served from `https://tauri.localhost` on Windows, so same-origin `/api` has no Express server and HTTP API origins are blocked as mixed content. Tauri injects the configured CSP into the bundled assets; the desktop development window loads Vite directly and, with `VITE_API_BASE` empty, reaches the local API through Vite's same-origin `/api` proxy. The CSP therefore no longer allows `http://localhost:8787`. The local-development helper is not bundled or run in the installed application; API secrets must never be packaged into the executable, and no secret may be placed in a `VITE_` variable.

Allow these specific origins as appropriate:

| Service | Development | Packaged Windows |
| --- | --- | --- |
| Privy allowed origins (desktop) | `http://localhost:1420` | `https://tauri.localhost` |
| API `ALLOWED_ORIGINS` | `http://localhost:1420`, `http://127.0.0.1:1420` | `https://tauri.localhost` |

The API's built-in `ALLOWED_ORIGINS` default (used only when the variable is unset) is `http://localhost:1420`, `http://127.0.0.1:1420`, `https://tauri.localhost`, `tauri://localhost`, `https://antara.tech`, `https://www.antara.tech` and `chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin`. The deployed service sets `ALLOWED_ORIGINS` explicitly, so the Render value must list the packaged desktop origin, the web origins and the extension origin itself.

Use a separate Privy development app. Confirm that the configured Privy app accepts the packaged origin before distributing a funded release. Adding the origin in the API's CORS list does not configure Privy. Privy CAPTCHA must stay **off**: the desktop CSP no longer allows Cloudflare Turnstile or hCaptcha, so turning CAPTCHA on would break desktop login rather than load a third-party script next to native IPC. [Privy allowed origins](https://docs.privy.io/recipes/dashboard/allowed-domains).

## Desktop authentication boundaries

### Owner setup checklist — October 9, 2026

Local setup status: the Privy credentials and Relay key are saved in ignored environment files, and public development RPCs are configured. All static development checks pass. These are no longer missing owner inputs for local testing. The authenticated Relay quote check revealed a settlement/refund-policy mismatch and remains blocked from execution; see `RELAY.md`. The dashboard settings and personal authentication steps below remain outstanding, and production hosting/dedicated RPCs are later release work.

1. In the Privy app, open **User management → Authentication** and enable **Email** and **External wallets**, with both **EVM** and **Solana** selected. Leave SMS off. ANTARA requests both Ethereum and Solana embedded wallets for all users automatically through the login modal; do not create a shared wallet for all users in the dashboard. Social login, including X, is deferred.
2. Under **Authentication → MFA → Enable MFA for transactions**, enable **Authenticator / TOTP** and save. Sign into ANTARA and enroll through **Protection → Set up wallet MFA**. Dashboard availability and an individual user's enrollment are separate. Passkey support still needs acceptance testing in the packaged desktop runtime.
3. In **Set allowed origins**, configure the React/web origin entries `http://localhost:1420`, `http://127.0.0.1:1420` (if used), and `https://tauri.localhost` for the current Windows test setup. Keep development origins separate from the future production Privy app. Tauri remains a desktop app; this origin setting is for its React SDK.
4. Prepare **Wallet infrastructure → Fee sponsorship → App pays / Sponsor gas fees** for Solana, Ethereum and Base. (Updated October 12, 2026 for the Solana-primary network set: Arbitrum and Polygon are no longer supported. Privy sponsorship on BSC and Robinhood Chain is unconfirmed; treat it as unavailable there.) Mainnet sponsorship needs billing and available credits. Use a fixed test budget and leave automatic refill disabled initially. Leave **Allow transactions from the client** disabled for the planned backend-controlled sponsorship flow.
5. Create an ANTARA development API key in the [Relay Dashboard](https://dashboard.relay.link) and save it as `RELAY_API_KEY` in the existing `server/.env`. To also cover Relay destination fees, link a separate sponsorship wallet under **App Balance** and use the dashboard's funding flow. Relay's ordinary destination-fee subsidy does not pay the source transaction's native gas.
6. Populate `SOLANA_RPC_URL`, `ETHEREUM_RPC_URL`, `BSC_RPC_URL`, `ROBINHOOD_RPC_URL`, and `BASE_RPC_URL` in the existing `server/.env` (`ARBITRUM_RPC_URL` and `POLYGON_RPC_URL` are no longer used). Populate public, origin-restricted `VITE_SOLANA_RPC_URL` and `VITE_SOLANA_WS_URL` in `.env.local`. Use mainnet endpoints, and keep both Solana cluster settings at `mainnet-beta`. Never overwrite the existing environment files with the templates.
7. For a packaged application, the production API origin is `https://antara.tech`. Build with `VITE_API_BASE=https://antara.tech` (see [Build an installer](#build-an-installer)); local development can keep it empty. App secrets and the Relay key belong only on the API server.

**Current boundary:** these settings prepare the accounts. ANTARA's existing execution code still requires native source gas. Backend-sponsored submission, spending quotas, provider compatibility, and zero-native-balance acceptance tests must be implemented and verified before showing a gas-free state. A dashboard switch does not establish those properties. Multisig releases remain separate from sponsorship and still require the vault's owner quorum.

Owner handoff: confirm which dashboard items are saved, which RPC entries are populated, and the maximum test sponsorship budget. Do not send credentials in chat. Funding a sponsorship balance is not permission for the application or developer to execute arbitrary mainnet transactions.

### Setup checks without screen control

Run `npm run doctor -- --development` to validate local configuration without printing values. Run `npm run doctor:privy -- --development` to read the Privy app's public configuration and verify email login, EVM and Solana external-wallet support, TOTP availability, and development origins. SMS is not required. Omit `--development` to check the packaged Windows origin instead. This second command makes a read-only request to Privy using only the public app ID; it never sends the app secret, logs a user in, enrolls MFA, or submits transactions. Dashboard configuration and per-user enrollment are distinct checks.

Privy's installed SDK exposes app-settings reads but no supported update operation for these settings. Login methods, MFA availability, and allowed origins must therefore be saved in the dashboard. An empty origin list means no explicit origin restrictions, not proof that login will fail.

For local development, the ignored `server/.env` was populated with the installed Viem chain definitions' public Ethereum, Base, Arbitrum, and Polygon RPCs after read-only `eth_chainId` and `eth_blockNumber` checks passed on October 9, 2026. The application's balance reader also completed all eight native/USDC reads across these four networks using the public zero address. No user account or funded transaction was involved. These shared endpoints can be rate-limited and should be replaced with dedicated RPCs before release. This record predates the October 12, 2026 network change: the Arbitrum and Polygon entries are no longer used, and BSC and Robinhood Chain endpoints were not part of that check. Environment changes take effect when the local API next starts; no running desktop app was restarted by this setup check.

References: [Privy MFA](https://docs.privy.io/authentication/user-authentication/mfa/setup), [Privy gas sponsorship](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup), [Relay API keys](https://docs.relay.link/references/api/api-keys), [Relay sponsorship](https://docs.relay.link/features/fee-sponsorship).

### Current runtime behavior

The desktop and ordinary browser login modals both offer email OTP and external-wallet login. The SDK configuration explicitly selects those two methods. Email and both EVM and Solana external-wallet login must be enabled in the Privy dashboard; the frontend cannot override a disabled provider. SMS is not offered.

Email OTP avoids a system-browser return callback. X and other social methods remain future work: native OAuth needs an explicit, reviewed browser-to-app redirect flow. ANTARA does not spoof a browser user agent or move access tokens through URLs. [Privy native OAuth guidance](https://docs.privy.io/recipes/capacitor-oauth).

This setup uses authenticator/TOTP for the extra wallet factor. Enabling email or external-wallet login does not enroll wallet MFA. Authenticated desktop login and per-user MFA enrollment remain live acceptance checks. [Login configuration](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods), [MFA setup](https://docs.privy.io/authentication/user-authentication/mfa/setup).

Browser extensions installed in Chrome or Edge are not automatically present in Tauri's separate WebView2 profile. Use the embedded Privy wallets for the initial desktop flow. External guardian wallet connectivity must be tested with the actual supported connector; wallet discovery does not imply that a hardware wallet or extension is connected. Independent owners can also approve vault proposals through compatible Squads/Safe tooling.

Privy MFA enrollment and signing prompts remain enabled. Verify passkey or TOTP enrollment and enforcement on the target WebView2 version with a configured Privy app; the desktop app does not claim that the old native WebAuthn bridge automatically protects Privy wallets. The CSP `frame-src` is an exact allowlist: Privy's iframe origin `https://auth.privy.io` and the two WalletConnect verification frames (`https://verify.walletconnect.com`, `https://verify.walletconnect.org`). Nothing else may be framed. The `https://*.privy.com` wildcard was removed on October 12, 2026: the installed Privy SDK (3.48.0) frames its embedded wallet from its API origin, `https://auth.privy.io`, and contains no `privy.com` URL, and the configured Privy app's public settings set no custom API domain. If a Privy custom domain is configured later, add that exact origin to `REQUIRED_FRAMES` in `scripts/check-desktop-build.mjs`, to `tauri.conf.json`, to the API server's header and to `extension/policy.mjs` together. Scripts load only from the app itself (`'self'` plus `'wasm-unsafe-eval'`); CAPTCHA hosts were removed on October 12, 2026 because Privy CAPTCHA is off. The API server's CSP header and the extension's CSP use the same frame allowlist, and `scripts/check-desktop-build.test.mjs` fails if they diverge. [Privy CSP requirements](https://docs.privy.io/security/implementation-guide/content-security-policy).

## Preserved native capabilities

The Rust encrypted local vault, native Windows WebAuthn, USB and disk enumeration, Bluetooth/location helpers, and isolated embedded browser implementation remain in `src-tauri/src`. They are not represented as active signers or mandatory security factors for a newly created Privy wallet.

### Native command access

Native commands are explicitly permissioned for the local main app webview (`src-tauri/capabilities/default.json`). Embedded browser children and remote origins, including the Privy and WalletConnect frames inside the main window, receive no native capabilities. The browser blocks local/internal navigation and unmanaged popup windows. Some websites that require popup authentication will need a separately designed integration; opening a popup is not permitted by default. Navigation checks are not a DNS or subresource firewall.

On October 12, 2026 these commands were withdrawn from the main webview. They stay compiled and enrolled, so Tauri's ACL rejects every call to them:

| Command | Why it was withdrawn |
| --- | --- |
| `sign_hash`, `stealth_sign` | Sign an arbitrary 32-byte digest (blind signing) with a local vault key. |
| `reveal_mnemonic`, `reveal_private_key` | Return the vault's recovery phrase or a private key to JavaScript. |
| `import_account` | Accepts a raw private key from JavaScript. |
| `webauthn_make_credential`, `webauthn_get_assertion` | Native Windows WebAuthn bridge; it does not protect Privy wallets. |
| `list_drives` | Enumerates every mounted drive; nothing in the current wallet uses it. |

The main webview also hosts third-party wallet frames, so a key-reveal or blind-signing command one script injection away is not acceptable. The owner confirmed that the old local keystore (`/legacy`) holds no funds. `app.withGlobalTauri` is now `false`: no source uses `window.__TAURI__`, and `@tauri-apps/api` works without it. Consequence: legacy screens that reveal, import or sign with the local vault receive an ACL error instead of a result.

Since the October 12, 2026 integration pass, `/legacy` in the native app renders a notice (`src/solares/LegacyRetired.tsx`) instead of the old workspace, so no UI path reaches the keystore's create, import, add-account, receive or stealth screens, and the Guide no longer links to it. `src/lib/vault.ts` turns a Tauri "not allowed" refusal into "Local keystore signing, key reveal and import are disabled in this desktop build." The keystore's receive commands (`create_vault`, `import_vault`, `add_account`, `stealth_meta_address`, `stealth_scan`) are still granted at the ACL; withholding them too is ready (move them to `MAIN_DENIED` in `browser.rs` and `DENIED_COMMANDS` in `scripts/check-desktop-build.mjs`) but awaits owner sign-off. Do not deposit to a legacy keystore account or its stealth addresses.

Rust regression tests in `src-tauri/src/browser.rs` assert the exact granted set, that every registered command is classified as granted or withheld, and that the runtime ACL denies the withheld commands to the main webview, its remote frames and child webviews.

ANTARA retains application identifier `app.solares.wallet` so the rename preserves the existing local data profile. It does not silently copy or overwrite the original application's encrypted vault file, session cookies, local storage, or keys. Existing vault recovery and migration remain explicit owner-controlled operations.

## Build an installer

From the repository root in Windows PowerShell:

```powershell
npm.cmd run desktop:build
```

`desktop:build` sets `VITE_API_BASE=https://antara.tech` for that build when the shell has no value (it prints "Packaged desktop API: …"). A shell value overrides it and the empty development `VITE_API_BASE` in `.env.local` without editing that file. Packaged builds that should offer paired vaults also need the public guardian pin `VITE_ANTARA_GUARDIAN_SOLANA` in the shell. `npm.cmd run check:desktop` runs the configuration half of the check on its own; `npm run check` and CI run it too. Tauri's `beforeBuildCommand` runs `npm run build:app` and then `node scripts/check-desktop-build.mjs --installer`, so bundling stops unless:

- `VITE_API_BASE`, resolved the way Vite's production build resolves it, is exactly the production origin `https://antara.tech`. Any other public `https://` origin is an error unless the shell sets `ANTARA_DESKTOP_STAGING=1` (see below). Credentials, a path, a query or a fragment are always rejected;
- `dist/` is a production build that contains that origin, does not reference `localhost:8787`, has no inline `<style>` or `<script>` in `index.html`, and has no secret-looking `VITE_` variable name;
- `tauri.conf.json` and the capability file keep the invariants above: identifier `app.solares.wallet`, a single `main` window with `useHttpsScheme`, `withGlobalTauri: false`, no CAPTCHA or local API hosts in the CSP, `frame-src` limited to the reviewed allowlist, exactly one capability scoped to `main`, and none of the withheld commands granted.

A staging installer points at a non-production API and must not be distributed. Build it only with the explicit opt-in, which keeps printing a staging warning:

```powershell
$env:ANTARA_DESKTOP_STAGING = '1'
$env:VITE_API_BASE = 'https://<staging-api-origin>'
npm.cmd run desktop:build
Remove-Item Env:ANTARA_DESKTOP_STAGING, Env:VITE_API_BASE
```

Run `node scripts/check-desktop-build.mjs` without arguments for the configuration checks alone. The check's unit tests are in `scripts/check-desktop-build.test.mjs` (`node --test scripts/check-desktop-build.test.mjs`). They cover each configuration invariant, the local-API pattern (including `[::1]:8787` and `0.0.0.0:8787`), the staging opt-in, the built-folder checks, and the frame allowlist shared with the API server and the extension. A public `VITE_` RPC URL that carries a provider key produces a warning that names the variable only; such a key must be origin-restricted, because it is inlined into the installer.

Allow `https://tauri.localhost` in the desktop Privy app client and in the deployed API's `ALLOWED_ORIGINS` before testing the installer. The configured Windows bundle is NSIS under `src-tauri/target/release/bundle/nsis/`. A successful debug build is not a signed installer. Distribution still requires the configured production API/Privy origins, code signing, and a small-value acceptance test on the actual packaged runtime.

Do not change `useHttpsScheme` or the app identifier casually after release: they determine the local storage/cookie origin and application data location. [Tauri window and protocol configuration](https://v2.tauri.app/reference/config/#usehttpsscheme).

## Verified in this workspace

- Rust `cargo check --locked` and `cargo build --locked` passed on Windows.
- Before the ANTARA rename, `npm run tauri dev -- --no-watch` started the native executable under its previous AETHRA name with an active WebView2 subprocess and no Rust startup errors. This records historical runtime validation, not a launch of the renamed executable.
- The native debug executable is `src-tauri/target/debug/antara-desktop.exe` and depends on the development services.
- `npm run desktop:build -- --no-bundle` previously passed for the standalone optimized Windows application. The current release output path is `src-tauri/target/release/antara-desktop.exe`. It includes the frontend assets and does not require Vite; it is not code-signed.
- Privy login/MFA, real wallet signing, funded vault operations, and Relay settlement still require the user's app credentials and RPC configuration; they have not been represented as live-tested.
- October 12, 2026 hardening: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` passed (12 tests, including the exact-grant and withheld-command ACL tests). Re-adding `allow-sign-hash` to the capability file made both ACL tests fail, as intended. `node scripts/check-desktop-build.mjs` passed on the configuration. A production frontend build with `VITE_API_BASE=https://antara.tech`, made outside the repository without reading `.env` files, passed the `--installer` check (no `localhost:8787` reference; the origin was inlined). The same check rejected an empty, an HTTP localhost and a mismatched API base. No installer was bundled and the packaged window was not launched, so packaged login against `https://antara.tech` is still an open acceptance step.
- October 12, 2026 review fixes: `https://*.privy.com` was dropped from the desktop CSP and the API server header, and `frame-src` became an exact allowlist. The local-API pattern now also matches `[::1]:8787` and `0.0.0.0:8787`. A non-production `VITE_API_BASE` became an error without `ANTARA_DESKTOP_STAGING=1`. The installer license text (`src-tauri/installer/About-ANTARA.txt`) was rewritten for paired vaults and the withdrawn keystore commands. `node --test scripts/check-desktop-build.test.mjs` passed (17 tests); reverting the old local-API pattern, the old frame check, the staging opt-in or the `withGlobalTauri` check each made it fail. `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` passed again (12 tests), as did `npm --prefix server test` (179 tests) and the server typecheck. The `--installer` check passed on the earlier out-of-repository production build with `https://antara.tech`; it rejected `https://evil.example.com` without the opt-in; with the opt-in it warned and then failed only because that build does not contain the staging origin. No installer was bundled and Privy login was not exercised; the frame allowlist rests on the SDK source and the app's public settings.
