# ANTARA vault protection layers (paired Solana vaults)

Status on 2026-10-13 (integration pass): **implemented, with automated tests, not live.** The server engine (`server/src/solares/layers/`), the client collectors and UI (`src/solares/layers/`), the native Windows commands (`src-tauri/src/layers.rs`, `layer_passkey*.rs`) and the extension policy are integrated, and a headless end-to-end test drives the shipped client flow code against the real server routes (`src/solares/layers/endToEnd.test.ts`; evidence in [VERIFICATION.md](VERIFICATION.md)). **Not done:** owner provisioning of the guardian, the owner switch (`ANTARA_PAIRED_VAULTS_ENABLED` stays unset), the §15 hardware checks (real passkey, location, Wi-Fi and Bluetooth on the owner's devices), and funded acceptance. Sections marked **Changed in implementation** record where the build differs from the first draft of this spec; open owner decisions are D1 to D4 in [section 16](#16-owner-decisions). It builds on the paired-vault guardian in [GUARDIAN.md](GUARDIAN.md); read that first.

> **Owner decision 2026-10-13: no MFA on the regular wallet; MFA is ANTARA's own vault authenticator.** The owner will not enable Privy wallet MFA, so nothing reads Privy `mfa_methods` any more: vault registration, activation, release, layer changes and cancels need no Privy TOTP. The MFA layer is now an optional, vault-only RFC 6238 authenticator (SHA-1, 6 digits, 30 s, so Google Authenticator works), turned on like Bluetooth, Wi-Fi or Safe Zones:
> - **Enroll** (`mfa.add`, enroll routes, a tightening that needs the passkey): the server generates a 20-byte secret, returns it once as `capture.totp.secret` (base32); the client shows an `otpauth://` QR code (built on the client from the secret) and the manual key; the finish must carry `totp: { code }` from the new app. Only then is the secret stored, **sealed with AES-256-GCM** under `ANTARA_VAULT_TOTP_KEY` (32 bytes, base64; additional data binds it to the vault's multisig) in `VaultLayerConfig.mfa`. One authenticator per vault.
> - **Release / loosen / recovery:** while MFA is on, `required` lists `{ "id": "mfa", "evidence": "totp" }` and the evidence object carries `totp: { code }` for that single-use challenge (bound to the exact proposal digest and nonce). The code is accepted within ±1 step, and only for a step **after** the last accepted one (`mfa.lastStep`, written under the store lock), so a code is never usable twice, even for another release. Wrong, expired, replayed or missing codes are `403 layer-failed` for `mfa` and count toward the lockout.
> - **Turning it off** (`layer.disable` `mfa`) is a loosening (immediate, needs every enabled layer, a code included). A lost authenticator is a **7-day recovery** that waives `mfa`. The **passkey stays required** for every release.
> - **Fails closed:** without a valid `ANTARA_VAULT_TOTP_KEY`, nothing that needs the authenticator begins (503 `unavailable`); a missing key never turns MFA off. A recovery that waives MFA does not need the key.
> - `GET /solana/layers` reports MFA with the optional-layer rules (`enforced` exactly when on) and one `authenticator` item; it never returns the secret. `GET /solana/account` keeps `mfaEnrolled` only for wire compatibility (always `true`: no account-level MFA is required).
> - Code: `server/src/solares/layers/totp.ts` (node:crypto only), `policy.ts`, `service.ts`; client `layers/flow.ts` (`totpCode`), `VaultLayers.tsx` (QR + key + code), `LayerApproval.tsx` / `verification/VerificationSequence.tsx` (code field). Tests: `server/src/solares/vaultMfa.test.ts`, the "vault MFA" route test in `pairedVault.test.ts`, `src/solares/layers/flow.test.ts`, `schema.test.ts`.
>
> Statements below that MFA is "TOTP enrolled", "always enforced", "never waivable", or that TOTP enrollment is checked on registration, releases, changes or cancels are **superseded** by this note.

> **Owner decision 2026-10-13: no 24-hour delays, no default caps, Limits optional.** The owner removed every time delay and every money cap ANTARA had added:
> - **Changes apply immediately.** A loosening (turning a layer off, loosening it, adding an item to a layer that is on, removing the last original passkey or trusted device) no longer waits: it applies at once, but still needs the session and **every currently enabled layer** at finish. Tightening is unchanged (immediate, session plus passkey). Only the separate lost-device **recovery** (waiving a layer you can no longer satisfy) keeps its **7-day** delay and stays cancelable; it is the only change that can be pending.
> - **Limits is optional and off by default.** There is no default per-release or daily cap, no server ceiling and no minimum release (the former defaults, minimums and `ANTARA_VAULT_*` variables are gone). The user may set their own caps with `limits.set`, per asset, per release and/or per day, any positive amount; an unset value means no cap. Setting or lowering a cap is a tightening; raising or removing one, or `layer.disable` `limits`, is a loosening (immediate, needs every enabled layer). Limits carries no evidence, so it never fails a check and is never waived: it is simply turned off. MFA, like the other evidence layers, can be waived through recovery.
> - **No recipient link age.** A release may go to any wallet Privy lists as linked to the user (the own-wallet rule is unchanged); the former minimum link age is gone.
> - **Kept:** the guardian's anti-abuse vote rate limits (they bound the SOL G pays in fees; defaults raised so they do not block normal use), HTTP rate limits, every cryptographic check, the own-wallet rule and fail-closed behaviour.
>
> Statements below about a loosening delay, server or default limits, a minimum release, a ceiling, a link age, or Limits being always enforced or never waivable are **superseded** by this note.

The six layers on the public landing page (`src/solares/landing/protectionLayers.ts`) are Biometrics, MFA, Safe Zones, Wi-Fi, Bluetooth and Limits. This spec turns each one into a check that gates the guardian's (G's) vote on a release. ARGUS, the predecessor, trusted client readings blindly and passed when a factor was missing. ANTARA must not do either:

- every enabled layer **fails closed**
- all evidence is **bound to the exact proposal**
- the UI and docs say what each layer really is: **Cryptographic**, **Device-reported** or **Server-observed**

Four engineers can build this in parallel from this document, in the ownership areas in [section 13](#13-implementation-plan-four-disjoint-areas). There is no shared TypeScript module between client and server. Each side implements the contract in this document, and its tests pin the JSON examples given here.

## 1. Key decisions

1. **One passkey relying party for every surface: `rpId = antara.tech`.**
   - **Web:** uses it natively.
   - **Extension:** since Chrome 122, an extension page can claim the RP ID of any site it has host permission for. The extension already has `https://antara.tech/*`. The `clientDataJSON` origin is still `chrome-extension://<id>`.
   - **Desktop:** does not use WebView2 WebAuthn, which is unreliable (see [section 2](#2-verified-platform-capabilities)). It calls Windows `webauthn.dll` through two **new, narrow** Tauri commands. The RP ID is pinned in Rust, and the `clientDataJSON` origin is fixed to `https://tauri.localhost`.
   - **One credential can work everywhere:** a Windows Hello passkey for `antara.tech` is usable from all three surfaces on the same PC. A phone passkey is usable from any surface through the OS "use a phone" (hybrid) dialog.
   - **Not used:**
     - Related Origin Requests (ROR).
     - A custom `antara.tech/approve` QR page.
     - The legacy `webauthn_make_credential` and `webauthn_get_assertion` commands. These stay ungranted, because they accept any RP ID and origin from JavaScript.
2. **MFA freshness cannot be proven server-side through Privy.** Privy's access token has no MFA claim, and `@privy-io/node` 0.35.0 has no "recent MFA" API.
   - *(Superseded 2026-10-13.)* The MFA layer was "TOTP enrolled" (re-read from Privy on every vote). It is now ANTARA's own vault authenticator, whose code ANTARA checks itself for each release while it is on (see the note at the top).
   - Per-release, server-verified user verification comes from the Biometrics passkey instead.
3. **Wi-Fi depends on the surface.**
   - **All surfaces:** the network check uses the public IP the server observes (`clientIp(req)`: Cloudflare's `CF-Connecting-IP` on Render, otherwise `req.ip` with `TRUST_PROXY`), matched against an enrolled prefix. This is the "trusted network".
   - **Desktop only:** it can also require the connected SSID and BSSID, from a new Rust command over `wlanapi`.
   - Browsers and extensions have no Wi-Fi API.
4. **Bluetooth depends on the surface.**
   - **Desktop:** the enrolled classic Bluetooth device must be *connected*, using the existing Win32 enumeration, filtered to connected devices.
   - **Extension and web:** Web Bluetooth `requestDevice()`. The chooser lists only nearby advertising BLE devices, and the selected device's per-origin ID must match the enrolled one.
   - **Distance is never measured.**
5. **Safe Zones:**
   - **Device location:** the desktop uses the native WinRT `Geolocator`; the extension and web use `navigator.geolocation`. The extension needs the `geolocation` manifest permission, which cannot be optional.
   - **The check:** the reading is compared with a safe zone (center and radius). It must satisfy both `accuracy ≤ radius/2` and `distance + accuracy ≤ radius`.
   - **No server-side IP geolocation in v1.** DB-IP Lite would work offline without a key, but city-level accuracy would cause false denials. The trusted-network check is the stronger server-observed signal.
6. **Trusted devices.** Every device-reported reading is signed by a per-vault, per-device, non-extractable WebCrypto P-256 key kept in IndexedDB.
   - The key is registered at enrollment. Readings from an unenrolled device are rejected.
   - This is a software key in the browser or app profile, not secure hardware, and the UI says so.
7. **Binding.**
   - Each approval or change uses a single-use, in-memory server nonce. It has a 5-minute TTL and is bound to the Privy user, session, vault, purpose and a SHA-256 digest of:
     - **for a release:** the fresh on-chain vault transaction bytes and the decoded intent
     - **for a change:** the normalised change operation and the config version
   - The WebAuthn challenge is `SHA-256(domain ‖ nonce ‖ digest)`.
   - The device payload echoes the nonce and the digest.
8. **Changes.**
   - **Tightening:** turning on or tightening a layer is immediate.
   - **Loosening:** turning off or loosening needs every currently enabled layer, and applies immediately (owner decision 2026-10-13). Adding a passkey, device, place, network or Bluetooth device to a layer that is already on counts as loosening (the first item turns the layer on, which is tightening).
   - **Waiving:** a change may *waive* layers the user can no longer satisfy (lost phone, moved house). It then becomes a **recovery** change with a **7-day** delay (owner decision O1), visible and cancelable until then. Any evidence-bearing optional layer that is on can be waived, MFA included. Limits carries no evidence and is never waived; it is turned off with an ordinary (immediate) loosening.
9. **Storage.**
   - **Layer configuration:** lives in the existing paired-vault store document. `DATA_DIR/paired-vaults-solana.json` goes to version 2, so it has the same atomic writes, marker-based loss detection and fail-closed validation. A lost or unreadable store is never read as "no layers".
   - **Nonces:** kept in memory. A restart invalidates outstanding challenges, which fails closed.
10. **Truthful status.** A layer shows as **Enrolled** or **enforced** only when the server says so in the response to a successful `GET /solana/layers`. If the route fails, or the guardian is not provisioned, no layer status is shown.

## 2. Verified platform capabilities

Checked on 2026-10-13. Recheck before go-live.

| # | Question | Finding | Consequence |
|---|---|---|---|
| a | WebAuthn in WebView2 (desktop, `https://tauri.localhost`) | WebView2Feedback issue #5663 (opened 2026-08-04, runtime 148, open, no Microsoft reply): Windows Hello prompt never appears and `isUserVerifyingPlatformAuthenticatorAvailable()` is `false` in WebView2, while Edge and Chrome work. The repo's own bridge comment also says `navigator.credentials` does not work in the Tauri webview. `tauri.localhost` is shared by **every** Tauri app on Windows, so even if it worked, an RP ID of `tauri.localhost` would not identify ANTARA. | Desktop uses `webauthn.dll` directly. `WebAuthNAuthenticatorGetAssertion` takes the RP ID as a parameter, and Microsoft's documentation states no caller-to-RP-ID rule, so a native app can use `antara.tech`. The RP ID is pinned in Rust. |
| b | WebAuthn in Chrome MV3 extension pages | Chrome's announcement (public-webauthn, 2023-12): from **Chrome 122**, extension pages can claim their own ID or the RP ID of any site they have host permission for (up to eTLD+1), but never another extension's ID or a public suffix. `clientDataJSON.origin` is the extension origin. Side panel: a third-party report says ceremonies in the side panel can show no prompt and hang. **Unverified.** | Bump `minimum_chrome_version` to `122`. Keep host permission `https://antara.tech/*`; if the user withdraws site access, the ceremony fails, which is closed. Until verified on real Chrome, run ceremonies in the full-tab surface (`wallet.html#vault`), never in the side panel. |
| c | Related Origin Requests (Chrome 128+) for `chrome-extension://` or `tauri.localhost` | WebAuthn L3 §5.11.1 skips any listed origin whose effective domain or registrable label is null. `chrome-extension://<id>` (a single-label host) can therefore never match. `https://tauri.localhost` could parse, but it is shared by every Tauri app, and browsers resolve `*.localhost` to loopback. Listing it would let any local server or Tauri app request `antara.tech` assertions. | **ROR is not used.** No `/.well-known/webauthn` file. (b) and the native bridge cover every surface. |
| d | Web Bluetooth in extension pages and WebView2 | A Chromium WebUSB/Bluetooth maintainer (Web Bluetooth CG, 2023-09) says Web Bluetooth works in extension *documents*, not service workers. The 2016 CG thread: the chooser works from extension pages. Side panel: **unverified**. WebView2: no chooser UI and no documented support. Treat as unavailable. | Extension and web use `requestDevice()` from a user gesture, in the full tab until the side panel is verified. Desktop uses native enumeration. Web Bluetooth is BLE-only; `getDevices()` does not show presence, so it is never evidence. |
| e | `navigator.geolocation` in extension pages, and WebView2 | Chrome docs: side panels and popups can call `navigator.geolocation`, but only with the `"geolocation"` manifest permission. Without it, the call fails immediately. The permission skips the prompt, shows the install warning "Detect your physical location", and **cannot be optional**. WebView2 is not used. Desktop already has `get_location` (WinRT), but it blocks the calling thread, never calls `RequestAccessAsync`, and returns `accuracy 0.0` when accuracy is unknown, which is **fail-open**. | Add `geolocation` to the extension permissions before the first Web Store submission (owner decision O2). The desktop gets a new `layer_location` command that fails closed. The legacy `get_location` must not be used for layers; area C also fixes its `unwrap_or(0.0)`. |
| f | Connected Wi-Fi SSID and BSSID from Rust on Windows | `windows` 0.58 (locked) has feature `Win32_NetworkManagement_WiFi`, with `WlanOpenHandle`, `WlanEnumInterfaces`, `WlanQueryInterface(wlan_intf_opcode_current_connection)`, `WlanFreeMemory`, `WlanCloseHandle` and `WLAN_CONNECTION_ATTRIBUTES` (SSID bytes and 6-byte BSSID). It is not enabled in `src-tauri/Cargo.toml` today. Microsoft, "Changes to API behavior for Wi-Fi access and location": from Windows 11 24H2, `WlanQueryInterface(current_connection)` returns `ERROR_ACCESS_DENIED` without precise-location consent, and a one-time prompt appears for user-context processes outside System32. This machine runs build 26200 (25H2), so it applies. | New command `layer_wifi_connections`. It maps `ERROR_ACCESS_DENIED` (5) to `location-consent-required`, and the UI offers `ms-settings:privacy-location` through `open_location_settings`. |
| g | Server WebAuthn library | `server/package.json` has `@simplewebauthn/server ^13.3.1`; 13.3.3 is installed. `verifyAuthenticationResponse` accepts `expectedOrigin` and `expectedRPID` arrays and enforces counter regression. The helpers export `isoCBOR`, used for the test authenticator. The client has `@simplewebauthn/browser` 13.3.0. Legacy `server/src/providers/webauthn.ts` (ARK, EVM Safe, in-memory challenges, file `vault-credentials.json`, platform attachment, hybrid hint stripped) is legacy-only. | Reuse the library, not the legacy module. New code lives in `server/src/solares/layers/`. |
| h | Privy MFA facts | `@privy-io/node` 0.35.0: `User.mfa_methods: Array<{type: 'sms'\|'totp'\|'passkey'\|'email'; verified_at: number}>`. `verified_at` is the enrollment time. `VerifyAccessTokenResponse` has only `app_id`, `issuer`, `issued_at`, `expiration`, `session_id` and `user_id`. Privy docs: once enrolled, MFA is required for embedded-wallet key use, within a dashboard-configured verification window. Privy documents no server-side proof of a recent MFA. | MFA layer = TOTP enrolled, plus Privy's own prompt at signing. Never claim per-transaction MFA. |
| – | No-key offline IP geolocation | DB-IP "IP to City Lite": CC BY 4.0 (attribution and link required), monthly, about 121 MB MMDB, no key. Accuracy index 77 (versus 96 for the commercial database); coordinates are approximate. | Omitted from v1 (owner decision O4). |

## 3. Threat model

| Attacker has | Without layers | With layers enabled |
|---|---|---|
| A stolen ANTARA session (Privy access token) only | Cannot sign as U unless Privy exchanges the JWT. See `--probe-user-jwt` in GUARDIAN.md. | Also needs every enabled layer. |
| Session plus U's signing | Can release to the user's own linked wallets, up to any caps the user set (none by default). | Also needs the passkey (user verification), a trusted device key, and readings that pass. Loosening needs every enabled layer. |
| Malware on the user's trusted device | Same as above. | Can sign false readings with the device key, but cannot fake the passkey's user verification or the server-observed IP. It **can** ask the user for that verification: on Windows, `webauthn.dll` accepts any relying-party ID and any `clientDataJSON` from any local process, so any local program (another Tauri app included) can show a genuine Windows Hello prompt for `antara.tech` over a challenge fetched with a stolen session. On desktop, the passkey binds the user's verification to the exact release challenge, but does not prove which local program asked; the `https://tauri.localhost` origin, shared by every Tauri app, identifies nothing. Device-reported layers are **not** proof against a compromised device. |
| A cloned or sideloaded extension, or local native code | — | An extension origin does not prove ANTARA's code asked: any unpacked extension that copies the public `key` (the development key in `extension-key.json`, or the store's public key) gets the same `chrome-extension://…` origin, and any native program can ask `webauthn.dll` for an `antara.tech` assertion with any `clientDataJSON` origin. Only the user's verification prompt stands in the way. A passkey's origin and the surface derived from it are therefore never treated as authentication; they only bind evidence to one app per request. Once the store ID exists, the development origin leaves the production origin lists ([extension/EXTENSION_ID.md](../extension/EXTENSION_ID.md), step 6). |
| A stolen session only, used for recovery | — | **Changed in implementation.** With a mandatory passkey, a stolen session (TOTP enrolled, no code needed) can schedule a recovery change that waives Biometrics and adds its own passkey. It takes effect after **7 days** unless the owner cancels it; after that, the recovery passkey can remove the owner's original passkey at once (2026-10-13: no extra wait). There are no notifications (O7), so the in-app warning on the vault card is the only signal. Owner decision D1 is open. |
| A compromised ANTARA server | Can vote with G (see GUARDIAN.md). | **Unchanged.** Layers are enforced by ANTARA's server, which could skip them. On the web, the server also serves the client code. |
| A network attacker | TLS protects the API. | The IP layer trusts the edge's `CF-Connecting-IP` on Render (a client copy is refused at the edge), otherwise `req.ip` behind exactly `TRUST_PROXY` hops. Anyone sharing the network, or a VPN exiting there, passes that layer. |

## 4. Layers per surface

Kinds:
- **C**: Cryptographic. The server verifies a signature, or the rule is enforced by the guardian's co-signature.
- **D**: Device-reported. Signed by a trusted device key, but the reading itself is whatever the device says.
- **S**: Server-observed.

| Layer (landing order) | Kind | Desktop (Tauri v2, `https://tauri.localhost`) | Extension (`chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin`) | Web (`https://antara.tech`) | What the server checks |
|---|---|---|---|---|---|
| Bluetooth | D | `layer_bluetooth_connected`: Win32 classic Bluetooth, **connected** devices only. The device ID is the 48-bit address. | Web Bluetooth `requestDevice({filters:[{name}]})` from a click in the full tab. The ID is Chrome's per-origin device ID. | Same as the extension (Chrome and Edge on desktop and Android; not Safari or Firefox) | The signed reading contains an enrolled device for this surface and source |
| Wi-Fi | S (+D) | Server IP check; plus SSID and BSSID from `layer_wifi_connections` in `network+radio` mode | Server IP check only | Server IP check only | The observed client IP (`clientIp(req)`) is within an enrolled prefix; in `network+radio` mode, also a signed desktop reading of an enrolled SSID with an enrolled BSSID |
| Biometrics | C | `layer_passkey_get` / `layer_passkey_create` (`webauthn.dll`, UV required, `rpId antara.tech`, origin `https://tauri.localhost`) | `@simplewebauthn/browser` `startAuthentication` / `startRegistration`, `rpId antara.tech`, in the full tab | Same, in page | Assertion signature, `rpIdHash`, origin allowlist, UV flag, challenge `H(nonce, digest)`, counter |
| Safe Zones | D | `layer_location`: WinRT `Geolocator` after `RequestAccessAsync` | `navigator.geolocation.getCurrentPosition({enableHighAccuracy:true, maximumAge:0, timeout:15000})`, with the manifest `geolocation` permission | Same API (site prompt) | A signed reading inside an enrolled zone, under the accuracy rule |
| MFA | C (ANTARA vault authenticator) | code typed by the user | code typed by the user | code typed by the user | When on: a 6-digit RFC 6238 code from the vault's sealed secret, ±1 step, single use per step |
| Limits | C (guardian) | none | none | none | Existing `evaluateRelease` with vault limits = min(server limits, vault's own) |
| *Trusted device* (supporting) | C (software key) | WebCrypto P-256 in WebView2 IndexedDB | WebCrypto in extension IndexedDB (the side panel and tab share it) | WebCrypto in `antara.tech` IndexedDB | ECDSA P-256 / SHA-256 over the exact payload bytes, with a registered and active key for that surface |

Rules a layer cannot satisfy on a surface:
- `network+radio` Wi-Fi mode can be satisfied **only from Desktop**. The extension and web are refused with "This vault's Wi-Fi layer requires ANTARA Desktop."
- Bluetooth devices enrolled on one surface are not matched on another, because the identifiers differ. A device must be enrolled per surface.
- **Changed in implementation:** while Bluetooth is on, a *new* app (surface) with no trusted Bluetooth device of its own cannot pass Bluetooth, so trusting that app's device key (`device.add`) is refused before any ceremony (`409`, naming the app) and the client offers **Waive Bluetooth and use recovery (7 days)**. Adding its Bluetooth device afterwards may need a second recovery. Owner decision D3 is open.

## 5. Data model

### 5.1 Server: `vaultStore.ts` document version 2

`DATA_DIR/paired-vaults-solana.json`

```ts
interface StoreDocument {
  version: 2;
  vaults: Record<string, PairedVaultRecord>;        // unchanged
  ledger: Record<string, LedgerEntry>;              // gains optional `layers`, below
  layers: Record<string, VaultLayerConfig>;         // key = multisig; absent = no optional layers, server limits
}
```

- **Reading version 1:** accepted as `layers: {}` (no vault had layers).
- **Writing:** always version 2.
- **An older server reading version 2:** refuses ("unexpected format"), which fails closed.
- **Validation:** every field below is checked strictly on every read, the same way `validRecord` and `validEntry` are. An unknown key, a wrong type, an empty item list for a non-null layer, or a duplicate ID throws `VaultStoreError`. Callers turn that into `503`.

```ts
type LayerId = 'biometrics' | 'mfa' | 'geolocation' | 'wifi' | 'bluetooth' | 'limits';
type OptionalLayerId = 'biometrics' | 'geolocation' | 'wifi' | 'bluetooth';      // can be enrolled, turned off, waived
type Surface = 'desktop' | 'extension' | 'web';

interface VaultLayerConfig {
  version: number;                 // >= 1, +1 on every applied change (immediate or due pending)
  webauthnUserId: string;          // base64url, 32 random bytes; never the Privy id
  biometrics: { credentials: PasskeyCredentialRecord[] } | null;          // 1..5
  geolocation: { zones: SafeZoneRecord[] } | null;                        // 1..3
  wifi: { mode: 'network' | 'network+radio'; networks: TrustedNetworkRecord[]; radios: WifiRadioRecord[] } | null;
                                   // networks 1..3; radios 0..3, and >= 1 when mode is network+radio
  bluetooth: { devices: BluetoothDeviceRecord[] } | null;                 // 1..3
  limits: { perReleaseRaw: { SOL: string | null; USDC: string | null }; perDayRaw: { SOL: string | null; USDC: string | null } } | null; // null = Limits off, no cap (2026-10-13)
  devices: TrustedDeviceRecord[];  // 0..5 trusted device keys
  pending: PendingChange[];        // 0..5, ordered by effectiveAt
  history: ChangeHistoryEntry[];   // last 50 applied or cancelled changes (no readings)
  updatedAt: string;               // ISO
}
interface PasskeyCredentialRecord {
  id: string;                      // base64url credential id (<= 1024 bytes decoded)
  publicKey: string;               // base64url COSE key
  counter: number;                 // uint32
  rpId: string;                    // RP ID at registration; must equal the configured RP ID to verify
  transports: string[];            // as reported, may be []
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;               // synced passkey when true
  aaguid: string;
  surface: Surface;                // from the registration origin
  label: string;                   // <= 40 chars, user text
  addedAt: string;
  addedVia?: 'recovery';           // present when a recovery change added it (implementation)
}
interface TrustedDeviceRecord { keyId: string; publicKeySpki: string; surface: Surface; label: string; addedAt: string; addedVia?: 'recovery' }
interface SafeZoneRecord { id: string; label: string; lat: number; lng: number; radiusM: number; addedAt: string }
                                   // radiusM 100..50000; lat -90..90; lng -180..180; all finite
interface TrustedNetworkRecord { id: string; label: string; cidr: string; addedAt: string }
                                   // normalised: IPv4 /24../32 (default /32), IPv6 /48../128 (default /64); no private, loopback, link-local, CGNAT or ULA ranges
interface WifiRadioRecord { id: string; label: string; ssid: string; ssidHex: string; bssids: string[]; addedAt: string }
                                   // ssidHex 2..64 hex chars; bssids 1..8, "AA:BB:CC:DD:EE:FF" uppercase
interface BluetoothDeviceRecord {
  id: string; label: string; surface: Surface; source: 'windows-classic' | 'web-bluetooth';
  identifier: string;              // windows-classic: 12 uppercase hex; web-bluetooth: Chrome device.id (<= 64 chars)
  name: string;                    // <= 64 chars, as reported (used as the requestDevice filter)
  addedAt: string;
}
interface PendingChange {
  id: string;                      // "chg_" + base64url(12 random bytes)
  op: ChangeOp;                    // normalised, with captured values (credential, cidr, reading-derived center, ...)
  class: 'loosen' | 'recovery';
  waived: OptionalLayerId[];       // [] for loosen
  requestedAt: string; effectiveAt: string;
  requestedFrom: Surface | null;   // null when the change carried no evidence that names an app (every enabled layer waived)
}
interface ChangeHistoryEntry { id: string; summary: string; class: 'tighten' | 'loosen' | 'recovery'; outcome: 'applied' | 'cancelled'; at: string }
```

Item IDs are `"<prefix>_" + base64url(12 random bytes)`, with prefixes `zone`, `net`, `radio` and `bt`. For passkeys the ID is the credential ID. For devices it is the `keyId`.

New labels (any op that takes one) are refused with `400` when they look like a value ANTARA masks: a full IPv4 or IPv6 address, a BSSID or Bluetooth address, a 12-hex identifier, or a coordinate pair (`layers/codec.ts` `looksIdentifying`, the same patterns as the client's unmasked-value check). Stored labels are not re-validated against this rule.

`LedgerEntry` gains an optional field, validated when present:

```ts
layers?: { challengeId: string; configVersion: number; passedAt: string; enforced: LayerId[] }
```

### 5.2 Server: in memory (`layers/challenges.ts`)

```ts
interface LayerChallenge {
  id: string;                      // base64url 16 random bytes
  nonce: Uint8Array;               // 32 random bytes
  privyUserId: string; sessionId: string;
  multisig: string;
  purpose: 'release' | 'change';
  transactionIndex?: string;       // release
  op?: ChangeOp; waived?: OptionalLayerId[]; class?: 'tighten' | 'loosen' | 'recovery';  // change
  digest: Uint8Array;              // 32 bytes
  configVersion: number;
  required: LayerRequirement[];
  issuedAt: number; expiresAt: number;     // TTL 5 minutes
  ip: string | null;               // observed public IP at begin
}
```

- `take(id)` removes the challenge and returns it, or null. It is single use even when verification later fails.
- Limits: at most 10 open challenges per user and 10,000 in total; the oldest are evicted. Expired challenges are swept on each issue.
- A failure lockout (`layers/lockout.ts`, in memory): 5 failed evidence evaluations per vault in 15 minutes lock that vault's layer routes and evidence-bearing approvals for 15 minutes (`429`, code `locked`, `Retry-After`).

### 5.3 Client: per device

- **IndexedDB:** database `solares-vault-layers`, version 1, object store `device-keys`, key `` `${privyUserId}:${multisig}` ``. The value is `{ keyPair: CryptoKeyPair, keyId, surface, createdAt }`.
  - The key comes from `crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, false, ['sign','verify'])`. The private key is non-extractable, and the public key is exported as SPKI DER.
  - If IndexedDB or WebCrypto is unavailable, device-reported layers are unavailable on that device. There is no fallback storage.
- **localStorage:** no layer data. The existing resume key `solares.paired-vault.proposal.v1:*` is reused for the extension tab fallback.

## 6. Binding, nonces and evidence formats

All hashes are SHA-256. "base64url" means without padding.

### 6.1 Digests (server-computed only; the client echoes them)

```
releaseDigest = SHA256(UTF-8 of these 10 lines joined by "\n", no trailing newline)
  ANTARA release v1
  cluster=<mainnet-beta|devnet>
  multisig=<base58>
  vault=<base58 vault PDA from the registration>
  transactionIndex=<decimal>
  transaction=<lowercase hex SHA256 of the VaultTransaction account data, from the fresh snapshot>
  asset=<SOL|USDC>
  amountRaw=<decimal>
  recipient=<base58 intent.recipient>
  destination=<base58 intent.destination>

changeDigest = SHA256(UTF-8 of these lines joined by "\n")
  ANTARA layer change v1
  multisig=<base58>
  configVersion=<decimal>
  op=<JSON.stringify(normaliseOp(op))>       // normaliseOp emits keys in the order listed in 8.1
  waive=<waived ids sorted, comma-joined, or empty>
```

At approval time, the server recomputes `releaseDigest` from **its own fresh snapshot** and the intent decoded by `evaluateRelease`. If it differs from the challenge's digest, the answer is `409 challenge-stale`. That covers a changed proposal, transaction or recipient.

### 6.2 WebAuthn challenge

```
webauthnChallenge(kind) = base64url(SHA256( UTF-8("ANTARA vault layers v1 " + kind) || 0x00 || nonce(32) || digest(32) ))
  kind = "get"     for assertions (release, change evidence)
  kind = "create"  for passkey registration
```

Server-side verification:

```js
verifyAuthenticationResponse({
  response,
  expectedChallenge: webauthnChallenge('get'),
  expectedOrigin: LAYER_ORIGINS,
  expectedRPID: [credential.rpId],
  requireUserVerification: true,
  credential: {...},
})
```

- `credential.rpId` must equal the configured RP ID.
- **Changed in implementation:** `@simplewebauthn/server` 13.3.x checks neither `crossOrigin` nor `topOrigin`, so `layers/passkey.ts` decodes `clientDataJSON` itself and refuses an assertion or a registration whose `crossOrigin` is `true`, that carries any `topOrigin` (a ceremony framed by another site), or whose client data cannot be read. `server/src/index.ts` also sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- The surface comes from the origin:
  - `https://tauri.localhost` → `desktop`
  - `chrome-extension://…` → `extension`
  - anything else on the allowlist → `web`
- The request options always carry `allowCredentials`, with every **active** credential (pending additions are excluded), `userVerification: 'required'`, `timeout: 120000` and `rpId`.

### 6.3 Device payload (signed by a trusted device key)

The client sends:

```json
{ "keyId": "…", "payload": "<base64url of the exact UTF-8 JSON bytes>", "signature": "<base64url 64-byte IEEE-P1363 r||s>" }
```

- The signature is over the decoded payload **bytes**, so no canonicalisation is needed.
- The server checks it with `crypto.verify('sha256', bytes, { key: spki, dsaEncoding: 'ieee-p1363' }, sig)` and only then calls `JSON.parse`.
- Size limits: the payload is at most 4 KB, and the whole evidence object at most 16 KB.

`DevicePayloadV1`. Unknown keys are refused, and every number must be finite.

```json
{
  "v": 1,
  "purpose": "release",
  "challengeId": "q3Jt0eS3h0d8a5bVt9k1JQ",
  "nonce": "<base64url 32 bytes, from begin>",
  "digest": "<hex 64, from begin>",
  "keyId": "<base64url of the first 16 bytes of SHA256(SPKI DER), 22 chars>",
  "surface": "desktop",
  "signedAt": 1791892800000,
  "geo": { "lat": 48.8566, "lng": 2.3522, "accuracyM": 35, "at": 1791892795000, "source": "windows-location" },
  "wifi": { "connections": [ { "ssidHex": "486f6d65", "bssid": "AA:BB:CC:DD:EE:FF" } ], "at": 1791892796000, "source": "windows-wlan" },
  "bluetooth": { "devices": [ { "identifier": "001A7DDA7113", "name": "Pixel 9" } ], "at": 1791892797000, "source": "windows-classic" }
}
```

Field rules:

- `purpose` and `digest` must match the challenge exactly.
- `geo.source`, `wifi.source` and `bluetooth.source` must match the key's surface:
  - desktop: `windows-location`, `windows-wlan`, `windows-classic`
  - extension and web: `browser-geolocation`, `web-bluetooth`
  - `wifi` is only allowed from desktop
- Desktop clients send only the Bluetooth devices whose identifiers are in the requirement's `match` list, the one device the user picked at enrollment, or both when a device is added while Bluetooth is on (§8.1). They never send the full list.
- Omit a reading that is not required. A reading present but not required is ignored and never stored or logged.

### 6.4 Evidence object (approve and change finish)

```ts
interface LayerEvidence {
  challengeId: string;
  passkey?: AuthenticationResponseJSON;   // when biometrics is required
  device?: { keyId: string; payload: string; signature: string };   // when any device reading is required
}
```

Surface consistency: when both `passkey` and `device` are present, the passkey's origin-derived surface must equal `payload.surface` and the trusted device's surface. Otherwise the request is denied with "Evidence came from different apps."

## 7. Evaluation rules: everything fails closed

`layers/policy.ts` exports `evaluateLayers(input): LayerDecision`. It is pure and synchronous. Its input is:
- the effective config (with due pending changes applied)
- the challenge (already taken)
- verified facts:
  - the passkey result from `layers/passkey.ts`
  - the parsed and verified device payload from `layers/device.ts`
  - the observed IP
  - the vault authenticator outcome (`totp`: the matched step, checked by the service against the sealed secret)
- `now`

Any exception counts as a denial.

**General rules.** Any failure means the guardian does not vote.
1. If no enabled optional layer exists, no evidence is needed. Limits is still enforced by the existing code. (Biometrics is mandatory, so in practice every release carries evidence.)
2. If an enabled layer needs evidence and the approve call carries no `layers`, the answer is `403 layers-required`, with the `required` list. Nothing is consumed or reserved.
3. Challenge checks:
   - It is unknown, expired, already used, or belongs to another user, session, vault, purpose or index: `403 challenge-invalid`.
   - Its `configVersion` is not the current effective version, or the digest no longer matches: `409 challenge-stale`. The client restarts once.
4. An unreadable or invalid layer config is `503 unavailable`. It is never treated as empty.
5. If the server cannot evaluate an enabled layer, the answer is `503`. Examples: a missing or invalid `ANTARA_LAYER_RP_ID` or `ANTARA_LAYER_ORIGINS` with biometrics enabled, or `TRUST_PROXY` false in production with no `CLIENT_IP_HEADER` and Wi-Fi enabled.
6. Every failure counts toward the lockout (§5.2) and writes one audit line (§9.6). The audit line never contains coordinates, SSIDs, BSSIDs, Bluetooth IDs, IPs or credential material.
7. Denial reasons name the layer and a short cause. They never reveal the stored zone center, the distance to it, or a stored identifier.

Per layer:

| Layer | Passes only if |
|---|---|
| Biometrics | `passkey` present; its credential ID is an **active** enrolled credential; the signature, RP ID hash, origin allowlist and UV flag verify; the challenge equals `webauthnChallenge('get')`; the counter does not regress (the new counter is stored under the store lock). |
| Trusted device (whenever a device reading is needed) | `device.keyId` is an active trusted device. Exception: in a `device.add` change, the candidate key from the op is used, and only for that one evaluation. The signature verifies over the payload bytes. `payload.keyId`, `challengeId`, `nonce`, `digest` and `purpose` all match. `signedAt` and every reading's `at` lie within [`issuedAt − 120 s`, `now + 120 s`]. |
| Safe Zones | `geo` present; source valid for the surface; `lat`, `lng` and `accuracyM` finite; `lat` in [−90, 90] and `lng` in [−180, 180]; `accuracyM > 0` (0, missing or NaN denies); and there is **some** zone with `accuracyM ≤ radiusM/2` and `haversine(center, reading) + accuracyM ≤ radiusM`. |
| Wi-Fi, network | The observed IP is not null. That requires `CLIENT_IP_HEADER` (the Render default) or `TRUST_PROXY` set in production, and a public address: not private, loopback, link-local, ULA or CGNAT. IPv4-mapped IPv6 is normalised to IPv4. The IP must lie in **some** enrolled `cidr` (`node:net` `BlockList.addSubnet` / `check`). |
| Wi-Fi, radio (only in `network+radio` mode) | The surface is desktop; `wifi.source` is `windows-wlan`; and some connection has `ssidHex` equal to an enrolled radio's `ssidHex` **and** a `bssid` in that radio's `bssids`. |
| Bluetooth | `bluetooth` present; source valid for the surface; some reported device's `identifier` equals an enrolled device's identifier **for the same surface and source**. Desktop readings list only connected devices by construction (§10). |
| MFA | Only when on: `totp.code` matches the vault authenticator's secret (opened with `ANTARA_VAULT_TOTP_KEY`) within ±1 step, and the step is after `mfa.lastStep`; the step is then recorded under the store lock. Can be turned off (immediate loosening) or waived (7-day recovery). |
| Limits | Only when on: `evaluateRelease` with `limits = effectiveReleaseLimits(vault.limits)`, exactly the caps the user set (a null value is no cap). No server default or ceiling (2026-10-13). Optional; turned off with `layer.disable` `limits` (a loosening), never waived. |

**Approval ordering in `guardian.approve`** (changes are marked NEW):
1. Parse the body, including the optional `layers`. Then the in-flight guard, `verifyGuardian`, `loadUser`, the TOTP check, the registration check, and `readReleaseSnapshot`.
2. NEW, outside the store lock:
   1. If `layers` is present, `take(challengeId)`. This consumes it even if a later step fails.
   2. Verify the passkey assertion and the device signature. Both are asynchronous crypto operations.
3. Under `store.withLock`:
   1. `evaluateRelease` (unchanged, effective limits). If the guardian has already approved, answer `already-approved`.
   2. The existing `pending` window answer. Neither of these needs layers.
   3. NEW: decide whether evidence is needed.
      - If the ledger already has a reservation for this (multisig, index) whose `layers.configVersion` equals the current version, and whose `passedAt` is less than 30 minutes ago, skip the layer step. This is the retry after a Privy signing failure.
      - Otherwise run `evaluateLayers` with the recomputed `releaseDigest`. A denial throws.
   4. Per-account caps, the global cap, and `recordApproval`. The entry gains `layers: {challengeId, configVersion, passedAt, enforced}`.
   5. Write the passkey counter.
4. Sign, as today.

**Changed in implementation (where the layer step runs).** `guardian.ts` is unchanged. The layer step runs in the `POST /solana/approve` route (`pairedVault.ts`) through `layers.authorizeRelease`, before the guardian service may reserve or sign, and it is the only consumer of the single-use challenge:
1. `authorizeRelease` checks the session id, ownership, the lockout and TOTP, reads a fresh snapshot, takes the challenge (single use even if a later step fails), and verifies the passkey and the device signature outside the store lock.
2. Under the store lock it runs `evaluateRelease`, answers `already-approved` and the 90-second `pending` window as before, requires a passkey on the vault (**every release needs Biometrics**, owner decision), honours the 30-minute retry of a passed reservation at the same configuration version, and otherwise runs `evaluateLayers` with the recomputed release digest.
3. On a pass it grants the store a **single-use release authorization** for that proposal (2-minute TTL, bound to the account, the configuration version and the vault's effective limits) and writes the passkey counter.
4. The guardian service then reserves and signs as before. The store, opened with `requireReleaseAuthorization`, refuses any reservation without that authorization (`409`), re-checks the vault's own caps (when the user set any) in the same locked section as the reservation, and records the layers that passed on the ledger entry. A direct call of `guardian.approve` therefore cannot skip the layers (tested).
5. One approval per account runs at a time (`409` otherwise), so two releases cannot both pass the vault's limits side by side.

## 8. Changes and enrollment

### 8.1 Change operations (`normaliseOp` emits keys in this order)

| `op.type` | Fields | Class | Values captured at finish |
|---|---|---|---|
| `passkey.add` | `label` | **Changed in implementation.** The vault's first passkey: tighten (immediate) only from the Privy session that registered the vault, within 15 minutes of registering (`noteRegistration`; since 2026-10-13 the window is stored on the registration, `activation` with a SHA-256 of the session id, so a restart or deploy keeps it); `403` from another session while that window is open; otherwise (window expired, or never recorded) a **recovery** change that waives Biometrics (7 days). Later passkeys: loosen | `registration` (RegistrationResponseJSON) verified with `webauthnChallenge('create')`, `requireUserVerification: true`, attestation `none` |
| `passkey.remove` | `credentialId` | tighten. **Changed:** the last passkey can never be removed (`403`); removing the last passkey *not* added through recovery, so that only recovery-added ones remain, is loosen | none |
| `device.add` | `label`, `surface`, `publicKeySpki` | tighten if no device-reported layer is enabled; otherwise loosen. **Changed:** while Bluetooth is on and the new key's app has no trusted Bluetooth device, refused (`409`) before any ceremony unless Bluetooth is waived (recovery) | proof of possession: the device payload signed by the candidate key, for the same surface as the request |
| `device.remove` | `keyId` | tighten. **Changed:** removing the last trusted device not added through recovery, while recovery-added ones remain, is loosen | none |
| `geolocation.add-zone` | `label`, `radiusM`, `center: "current" \| {lat,lng}` | tighten if geolocation is off; otherwise loosen | `"current"`: the signed `geo` reading becomes the center, and must satisfy `accuracyM ≤ radiusM/2` |
| `geolocation.remove-zone` | `zoneId` | tighten; loosen if it is the last zone | none |
| `wifi.add-network` | `label`, `prefixLength?`, `cidr?` | tighten if Wi-Fi is off; otherwise loosen | No `cidr`: the observed IP at finish, masked to `prefixLength` (default 32 or 64). Begin and finish must see the same IP. |
| `wifi.remove-network` | `networkId` | tighten; loosen if it is the last network | none |
| `wifi.add-radio` | `label` | tighten if Wi-Fi is on in `network` mode and has no radios (the mode does not change); loosen otherwise | The signed desktop `wifi` reading: exactly one connection becomes `{ssidHex, bssids:[bssid]}` |
| `wifi.add-bssid` | `radioId` | loosen | The signed desktop reading's BSSID for the same `ssidHex` |
| `wifi.remove-radio` | `radioId` | tighten; loosen if it is the last radio while in `network+radio` mode | none |
| `wifi.set-mode` | `mode` | `network → network+radio`: tighten (needs at least 1 radio); the reverse: loosen | none |
| `bluetooth.add-device` | `label` | tighten if Bluetooth is off; otherwise loosen | The signed `bluetooth` reading with exactly one device that is not enrolled yet (desktop: chosen from connected devices; web and extension: the `requestDevice` result). When Bluetooth is already on (loosen), the same reading also carries the enrolled device(s) that prove the layer: desktop sends the connected enrolled devices plus the chosen one; web and extension take two clicks (the approval chooser filtered to enrolled names, then the open chooser for the new device) and sign both in one reading |
| `bluetooth.remove-device` | `deviceId` | tighten; loosen if it is the last device | none |
| `limits.set` | `perReleaseRaw{SOL,USDC}`, `perDayRaw{SOL,USDC}` (each a positive raw amount, or `null` for no cap) | tighten if no cap is raised or removed; otherwise loosen | Validation (2026-10-13): each value is a positive whole number of raw units or null; per-release at most per-day when both are set. No minimum, no server ceiling |
| `layer.disable` | `layer: OptionalLayerId \| "limits"` | loosen. **Changed:** `biometrics` is refused (`403`): a passkey is required for every vault | none |

**Changed in implementation: nothing before a passkey.** Until a vault has a passkey in force, every change except `passkey.add` is refused (`409`, "Add a passkey to this vault first"), so nothing can be enrolled ahead of it. A pending first passkey (a recovery change) does not count.

**Changed in implementation: Wi-Fi capture exceptions.** In `network+radio` mode, `wifi.add-radio` is loosen, but the radio check for that one op accepts any single connection (the new network being captured), not an enrolled one; `wifi.add-bssid` accepts any BSSID of the target radio's SSID. The server-observed trusted-network check, every other enabled layer still applies. Turning this into a recovery that waives Wi-Fi was rejected because it would also drop the network check.

A change request may also carry `waive: OptionalLayerId[]`:
- The waived layers are not evaluated, and the class becomes **recovery** (7-day delay).
- Any evidence-bearing optional layer that is on can be waived, `mfa` included (2026-10-13). `limits` is never waived; it is turned off with `layer.disable` `limits`.
- Waiving a layer that is not enabled is `400`.
- **Changed in implementation:** Biometrics is mandatory but stays waivable, so a lost passkey can be replaced through a 7-day recovery.

### 8.2 Requirements and timing per class

| Class | Evidence needed at finish | Takes effect | Cancelable |
|---|---|---|---|
| tighten | Session and a passkey assertion if biometrics is enabled (and, for `mfa.add`, a code from the new authenticator). This limits lock-out pranks with a stolen session. | Immediately (version +1) | n/a |
| loosen | Session and **every** currently enabled optional layer (a vault authenticator code when MFA is on), plus the values captured for the op | Immediately (version +1; owner decision 2026-10-13) | n/a |
| recovery | Session and every enabled optional layer **except** the waived ones | `requestedAt + 7 days` (owner decision O1) | Until `effectiveAt` |

- **Applying due changes.** `effectiveConfig(config, now)` (pure) applies due pending changes in `effectiveAt` order, at version +1 each, and skips any whose target item no longer exists (recorded in history as `cancelled`). The service persists the result on the next write under the lock.
- **Releases** always use the effective config at that moment. A pending addition is never usable before it takes effect.
- **Cancel** needs a session. Cancelling restores protection, so a passkey is not needed.
- **Limits:** at most 5 pending changes per vault, and at most 10 change begins per account per minute.
- **No notifications.** ANTARA sends no email or push notification about pending changes. They are visible only in the app (owner decision O7).

## 9. API routes

All routes are mounted under `/api/solares/paired-vault`. They run behind:
- the existing pre-auth IP limit, `requirePrivyUser` and the 60-per-minute account limit
- `guardianRoute` error mapping, so `503 not-provisioned` applies while the owner switch is off
- `Cache-Control: no-store`

The body limit stays at 256 KB, but the routes refuse evidence over 16 KB. The vault must be registered to the caller: `409` if it is not registered, `403` if it belongs to another account. New write routes share a per-account limit of 20 per minute (`scope: 'layers-write'`).

`GuardianError` gains codes `layers-required | layer-failed | challenge-invalid | challenge-stale | locked`, and an optional `extra` object. `guardianRoute` copies `extra.required` or `extra.layers` into the JSON response, and only for those codes.

**Changed in implementation:**
- **Session id required.** `requirePrivyUser` (`wallet.ts`) records `verifyAccessToken().session_id` as `req.solaresUser.sessionId` (1 to 200 characters, otherwise none). Every route that issues or uses a challenge answers `503` without one, instead of binding every session as one. Reading the status and cancelling a pending change still work.
- **The first-passkey window** opens in `POST /solana/register` (status `registered`) for the registering session only. `already-registered` opens it only when the registration predates the server process (its own note lost in a restart or deploy), none was ever recorded for that vault, the vault has no passkey (none pending either) and it is still within 15 minutes of registering, so another session of the same account cannot claim a window this process is about to open; the deadline is always registration + 15 minutes and a recorded window is never moved to another session.
- **Locked answers** carry the wait twice: `Retry-After` and `retryAfterSeconds` in the body. The API also exposes `Retry-After` through CORS (`Access-Control-Expose-Headers`, `server/src/index.ts`).
- **Begin limit:** change and enroll begins also share `10` per account per minute (`layers-begin`).

### 9.1 `GET /solana/layers?multisig=<base58>`

```json
{
  "multisig": "<base58>",
  "configVersion": 7,
  "serverTime": "2026-10-13T10:00:00.000Z",
  "network": { "observed": true, "trusted": false },
  "layers": [
    { "id": "bluetooth", "kinds": ["device-reported"], "status": "not-enrolled", "enforced": false, "items": [] },
    { "id": "wifi", "kinds": ["server-observed"], "status": "enrolled", "enforced": true, "mode": "network",
      "items": [ { "id": "net_x1", "type": "network", "label": "Home", "detail": "IPv4 203.0.x.x/32", "state": "active", "since": "2026-10-10T08:00:00.000Z" } ] },
    { "id": "biometrics", "kinds": ["cryptographic"], "status": "enrolled", "enforced": true,
      "items": [ { "id": "<credential id>", "type": "passkey", "label": "Windows Hello", "detail": "Device-bound passkey · added from Desktop", "state": "active", "since": "…" },
                 { "id": "<credential id>", "type": "passkey", "label": "Phone", "detail": "Synced passkey · added from Web", "state": "pending-addition", "effectiveAt": "2026-10-14T09:00:00.000Z", "changeId": "chg_a1" } ] },
    { "id": "geolocation", "kinds": ["device-reported"], "status": "pending-removal", "enforced": true, "changeId": "chg_b2", "effectiveAt": "…",
      "items": [ { "id": "zone_q", "type": "zone", "label": "Home", "detail": "Radius 250 m", "state": "active", "since": "…" } ] },
    { "id": "mfa", "kinds": ["cryptographic"], "status": "enrolled", "enforced": true, "items": [] },
    { "id": "limits", "kinds": ["cryptographic"], "status": "enrolled", "enforced": true,
      "limits": { "perReleaseRaw": { "SOL": null, "USDC": "250000000" }, "perDayRaw": { "SOL": "10000000000", "USDC": null } } }
  ],
  "devices": [ { "keyId": "<22 chars>", "label": "Desktop", "surface": "desktop", "state": "active", "since": "…" } ],
  "pending": [ { "id": "chg_b2", "class": "recovery", "summary": "Turn off Safe Zones", "requestedAt": "…", "effectiveAt": "…", "waived": ["geolocation"] } ]
}
```

Field semantics:

- **Order:** `layers` is always all six, in landing order.
- **`status`:**
  - `enrolled`: a non-null layer with at least one active item. MFA counts as enrolled when TOTP is enrolled. Limits counts as enrolled when the user set at least one cap (2026-10-13: it is off by default; a null cap value means no cap, and there are no server, minimum or ceiling fields).
  - `not-enrolled`
  - `pending-removal`: enrolled, with a pending change that would turn it off
- **`enforced`:** `true` exactly when the status is `enrolled` or `pending-removal`, and for MFA always. An MFA layer that is `not-enrolled` with `enforced: true` means releases are paused. **Changed in implementation:** Biometrics is mandatory, so it is also always `enforced: true`; `not-enrolled` with `enforced: true` means releases are paused until a passkey is in force.
- **`kinds`:** Wi-Fi in `network+radio` mode is `["server-observed","device-reported"]`.
- **Item `state`:** `active`, `pending-addition` or `pending-removal`.
- **Never returned:**
  - zone centers
  - full IPs: IPv4 shows the first two octets plus the prefix, IPv6 the first three hextets plus the prefix
  - full BSSIDs: shown as `••:••:••:••:3F:A1`
  - Bluetooth identifiers: only the last 4 characters
  - public keys
- **`network`:** `observed` is false when the server cannot see a public IP. `trusted` reports whether this request's IP matches an enrolled network, or is null when Wi-Fi is not enrolled.
- **`pending[].summary`:** **changed in implementation** to ANTARA's fixed text only ("Add a passkey", "Turn off Safe Zones", "Trust a device (Desktop)"); the user's label of the item comes apart as an optional `pending[].label`. Clients still apply the unmasked-value check only to server-generated fields (`detail`, `capture.network.observedCidr`, failure reasons), never to a summary or label, so a label can never hide a pending change; the client shows the label in the Pending changes list only, never in the warning on the vault card.
- **Degraded view:** when a `200` fails the client's strict parse, the client shows no layer status, but still lists each pending change it can read (`id`, `class`, `effectiveAt`, and `waived` when valid) with **Cancel**.

### 9.2 `POST /solana/layers/approval/begin`

Request body: `{ "multisig": "<base58>", "transactionIndex": "12" }`.

The server:
1. Loads the user, checks TOTP and the registration, and reads a fresh `readReleaseSnapshot`.
2. Runs `evaluateRelease`. A release that would be refused is refused now, before the user is asked for anything.
3. Computes `releaseDigest` and issues the challenge.

Answer `200`:

```json
{
  "challengeId": "q3Jt0eS3h0d8a5bVt9k1JQ",
  "expiresAt": "2026-10-13T10:05:00.000Z",
  "purpose": "release",
  "nonce": "<base64url 32 bytes>",
  "digest": "<hex 64>",
  "configVersion": 7,
  "release": { "multisig": "<base58>", "transactionIndex": "12", "asset": "SOL", "amountRaw": "250000000", "recipient": "<base58>" },
  "required": [
    { "id": "biometrics", "evidence": "passkey" },
    { "id": "geolocation", "evidence": "device", "reading": "geo" },
    { "id": "wifi", "evidence": "server" },
    { "id": "bluetooth", "evidence": "device", "reading": "bluetooth",
      "match": [ { "surface": "desktop", "source": "windows-classic", "identifier": "001A7DDA7113", "name": "Pixel 9" } ] },
    { "id": "mfa", "evidence": "server" },
    { "id": "limits", "evidence": "server" }
  ],
  "devices": [ { "keyId": "<22 chars>", "surface": "desktop" } ],
  "webauthn": { "challenge": "<webauthnChallenge('get')>", "rpId": "antara.tech", "allowCredentials": [ { "id": "<cred>", "type": "public-key", "transports": ["internal","hybrid"] } ], "userVerification": "required", "timeout": 120000 }
}
```

- `webauthn` is `null` when biometrics is not required.
- `match` lists only enrolled Bluetooth devices. The client filters it to its own surface.
- **Changed in implementation (opaque Desktop match).** A Desktop (`windows-classic`) entry never carries the stored hardware address: its `identifier` is `bluetoothMatchId(nonce, address)` = uppercase hex of the first 6 bytes of `SHA256(UTF-8("ANTARA bluetooth match v1") ‖ 0x00 ‖ nonce(32) ‖ UTF-8(address))`, and its `name` is empty. ANTARA Desktop computes the same id for each connected device with the challenge nonce and signs only the raw addresses that match. Test vector: nonce of 32 × `0x01` and `001A7DDA7113` give `A81499E93C60` (pinned in the server and client tests). A 48-bit address space can be searched offline, so this stops casual reading of the address, not a determined attacker who holds the session. The `403 layers-required` body leaves Desktop entries out. Web Bluetooth entries (per-origin ids and the name filter) are unchanged.
- A Wi-Fi radio requirement reads `{ "id": "wifi", "evidence": "device", "reading": "wifi", "desktopOnly": true }` and has no match list. The client sends its current connections; the server never returns stored SSIDs or BSSIDs in this answer.
- **Changed in implementation:** a passkey is required for every release, so a vault with no passkey in force is refused (`403 layer-failed`, Biometrics) and there is no "no optional layer" answer; `webauthn` is always present on a release begin.

### 9.3 `POST /solana/approve` (extended)

```json
{ "multisig": "<base58>", "transactionIndex": "12",
  "layers": { "challengeId": "…", "passkey": { "id": "…", "rawId": "…", "type": "public-key", "response": { "clientDataJSON": "…", "authenticatorData": "…", "signature": "…", "userHandle": null }, "clientExtensionResults": {} },
              "device": { "keyId": "…", "payload": "…", "signature": "…" } } }
```

- **Success answers:** unchanged (`approved`, `pending`, `already-approved`).
- **New refusals:**
  - `403 {code:'layers-required', required:[…]}`
  - `403 {code:'layer-failed', layers:[{id:'geolocation', ok:false, reason:'Your reported location is outside your safe zones.'}, {id:'biometrics', ok:true}]}`
  - `403 challenge-invalid`
  - `409 challenge-stale`
  - `429 locked` (with `Retry-After`). ANTARA Desktop and the extension call the API cross-origin and can read that header only if the server exposes it (`Access-Control-Expose-Headers`), so the body may also carry `retryAfterSeconds` (integer), which clients use when the header is unreadable.

### 9.4 Enrollment and changes

| Route | Request | Answer |
|---|---|---|
| `POST /solana/layers/enroll/begin` | `{multisig, op}`, where `op.type` ends in `.add`, `.add-zone`, `.add-network`, `.add-radio`, `.add-bssid` or `.add-device`; plus optional `waive` | `{challengeId, expiresAt, purpose:'change', nonce, digest, configVersion, class, effectiveAt /* null when immediate */, required, devices, webauthn: {get: RequestOptionsJSON \| null, create: CreationOptionsJSON \| null}, capture: {geo?: true, wifi?: true, bluetooth?: 'choose', network?: {observedCidr: '<masked>'}}}` |
| `POST /solana/layers/enroll/finish` | `{multisig, challengeId, registration?, passkey?, device?}` | `{status:'applied', configVersion}` or `{status:'pending', change:{id, class, effectiveAt}}` |
| `POST /solana/layers/change/begin` | `{multisig, op, waive?}` for `*.remove*`, `wifi.set-mode`, `limits.set` and `layer.disable` | Same shape as enroll begin (no `capture`, `webauthn.create` is null) |
| `POST /solana/layers/change/finish` | `{multisig, challengeId, passkey?, device?}` | Same as enroll finish |
| `POST /solana/layers/change/cancel` | `{multisig, changeId}` | `{status:'cancelled', configVersion}`. Unknown or already applied: `409` |

`CreationOptionsJSON` for `passkey.add`:
- `rp: {id: <ANTARA_LAYER_RP_ID>, name: 'ANTARA'}`
- `user: {id: webauthnUserId, name: 'ANTARA vault <first 6>…<last 4 of multisig>', displayName: same}`
- `challenge: webauthnChallenge('create')`
- `pubKeyCredParams: [ES256 (-7), RS256 (-257)]`
- `authenticatorSelection: {residentKey:'preferred', userVerification:'required'}`, with no attachment, so phones (hybrid) are allowed
- `attestation:'none'`
- `excludeCredentials`: this vault's credentials
- `timeout: 120000`

### 9.5 Server configuration (new, server-only, never `VITE_`)

| Variable | Default | Rule |
|---|---|---|
| `ANTARA_LAYER_RP_ID` | `antara.tech` in production, `localhost` otherwise | A domain. Invalid: biometrics is `503`. |
| `ANTARA_LAYER_ORIGINS` | production: `https://antara.tech,https://tauri.localhost,chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin`; otherwise `http://localhost:1420,https://tauri.localhost,chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin` | Comma list of exact origins. Add the Chrome Web Store extension origin when it is assigned (as for `ALLOWED_ORIGINS`). |
| `TRUST_PROXY` | existing | In production, Wi-Fi network evaluation refuses (`503`) when it is `false` and `CLIENT_IP_HEADER` is off. |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` on a Render web service (`RENDER=true`), off otherwise | `cf-connecting-ip` or `none`; any other header (including `true-client-ip`, which a client can set on Render) is refused at startup. Names the client IP for the network check (`server/src/solares/clientIp.ts`). |

The legacy `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` and `vault-credentials.json` are **not** read by the layer code. `scripts/doctor.mjs` may report the two new names in the integration pass (§13.5), never their values.

### 9.6 Audit

One JSON line per decision:

```json
{"event":"antara.guardian.layers","at":"…","action":"approve|enroll|change|cancel|begin","outcome":"allowed|denied|pending|applied|cancelled|locked|error","privyUserId":"…","multisig":"…","transactionIndex":"12","layers":[{"id":"geolocation","ok":false}],"class":"loosen","reason":"<ANTARA text>"}
```

It never contains readings, IPs, SSIDs, BSSIDs, identifiers, keys, assertions or tokens.

## 10. Native commands (Rust contract, area C)

- **Error codes:** every new command returns `Result<T, String>`. The error string is exactly one of the codes below.
- **Field names:** JSON uses camelCase (`#[serde(rename_all = "camelCase")]`).
- **Threading:** commands are `async` and run blocking Win32 or WinRT work in `tauri::async_runtime::spawn_blocking`, so the WebView stays responsive.
- **Other platforms:** stubs return `Err("unsupported-platform")`.

| Command | Arguments | Ok | Error codes | Notes |
|---|---|---|---|---|
| `layer_wifi_connections` | none | `[{ssid, ssidHex, bssid}]`. Connected interfaces only, never empty. | `location-consent-required` (`ERROR_ACCESS_DENIED` = 5), `wifi-unavailable` (no WLAN service or interface), `not-connected`, `unsupported-platform` | `WlanOpenHandle(2)`, `WlanEnumInterfaces`, then for each interface in `wlan_interface_state_connected`, `WlanQueryInterface(wlan_intf_opcode_current_connection)`. Read `dot11Ssid` (length ≤ 32, bytes → `ssidHex`, lossy UTF-8 → `ssid`) and `dot11Bssid` as `AA:BB:CC:DD:EE:FF`. Always `WlanFreeMemory` and `WlanCloseHandle`. Add Cargo feature `Win32_NetworkManagement_WiFi`. |
| `layer_bluetooth_connected` | none | `[{id, name, kind:'classic'}]` with `fConnected` true only; may be `[]` | `bluetooth-unavailable` (no radio: `BluetoothFindFirstRadio` fails, or the enumeration errors), `unsupported-platform` | Same Win32 search as `list_bluetooth_devices`, with `fIssueInquiry: 0`. Remembered but disconnected devices are excluded. BLE-only devices are **not** listed (documented limit). A WinRT BLE extension is optional later. |
| `layer_location` | none | `{lat, lng, accuracyM, at}` | `location-consent-required` (`RequestAccessAsync` not `Allowed` or unanswered within 60 s, or `E_ACCESSDENIED`), `location-unavailable` (including a fix not measured on this computer, below), `accuracy-unknown` (`Accuracy()` errors, or is not finite and > 0), `unsupported-platform` | Call `Geolocator::RequestAccessAsync()` first (the one-time OS prompt). Microsoft requires it on the UI thread, so it is started on the main thread (`AppHandle::run_on_main_thread`) and its answer is awaited on the worker for at most 60 s; if the request itself fails for another reason, the command goes on to the fix, which Windows refuses without consent. `at` comes from `Geocoordinate.Timestamp` as ms since the Unix epoch. **Never** default the accuracy. **Source rule:** only a fix this computer measured is a reading. `Geocoordinate.PositionSource` must be `Satellite`, `WiFi` or `Cellular`, and `Geocoordinate.IsRemoteSource` must be `false`. Refused as `location-unavailable`: `Default` (the hand-typed default location Windows returns when it has no fix), `Obfuscated` (coarse location), `IPAddress` (not a device reading; the server checks the IP itself), `Unknown`, any other value, an unreadable source, a remote (Remote Desktop) fix, and an unreadable remote flag. `IsRemoteSource` exists from Windows 11 (build 22000), so desktop Safe Zones refuses every fix on Windows 10. |
| `layer_passkey_get` | `request: {rpId, challenge, allowCredentials: string[], timeoutMs}` | AuthenticationResponseJSON `{id, rawId, type:'public-key', response:{clientDataJSON, authenticatorData, signature, userHandle \| null}, clientExtensionResults:{}}` | `invalid-request`, `passkey-cancelled`, `passkey-failed`, `unsupported-platform` | `rpId` must be in a **compiled** allowlist: release `["antara.tech"]`, debug adds `"localhost"`. `challenge` is base64url decoding to exactly 32 bytes. `allowCredentials` has 1 to 16 entries, each 16 to 1023 bytes decoded. `timeoutMs` is 30,000 to 180,000. `clientDataJSON` is built with `serde_json` as `{"type":"webauthn.get","challenge":…,"origin":"https://tauri.localhost","crossOrigin":false}`. UV is required and the attachment is any (hybrid allowed). The parent HWND is the **main** window's, not `GetForegroundWindow()`. **Implementation:** it comes from `get_window("main")` (the in-app browser adds child webviews to the main window, so `get_webview_window` can return nothing), and cancellation is mapped through `WebAuthNGetErrorName`, which returns the same W3C names (`NotAllowedError` → `passkey-cancelled`). A result without both the user-present and user-verified flags, an assertion for a credential the request did not allow, and a new credential the request excluded are refused. One dialog at a time. |
| `layer_passkey_create` | `request: {rpId, rpName, challenge, userId, userName, userDisplayName, excludeCredentials: string[], timeoutMs}` | RegistrationResponseJSON `{id, rawId, type, response:{clientDataJSON, attestationObject, transports?}, clientExtensionResults:{}}` | as above | Same validation. `userId` is 1 to 64 bytes. Algorithms are ES256 and RS256 only. Attestation is none, UV is required, and `type` is `"webauthn.create"`. |
| `open_location_settings` | none | `()` | `unsupported-platform`, `location-unavailable` (Windows could not open the page; implementation) | Launches `ms-settings:privacy-location` from Rust (opener plugin Rust API or `ShellExecuteW`). It takes no argument, so JavaScript cannot choose the URI. |

Rules:
- The legacy commands stay as they are, still granted or still denied exactly as today. Area C also fixes the legacy `get_location` so that unknown accuracy is an error, not `0.0`, and applies the same source rule as `layer_location`. `get_location` must **never** feed a vault layer: it is a sync command that blocks the main thread with no timeout and never requests consent. Only `src/lib/devices.ts` (legacy ARK presence factors) calls it.
- Both passkey commands first call `authorize(label, url)`: the caller must be the `main` webview and its current page must be on `https://tauri.localhost` (debug builds also accept the development server `http://localhost:1420`, pinned to `build.devUrl` by a test). This runs before validation, the window lookup and any dialog, on top of the capability grant. It narrows which ANTARA webview may ask; it does not stop another local program from calling `webauthn.dll` itself (§3).
- `webauthn_make_credential` and `webauthn_get_assertion` stay in `DENIED_COMMANDS`.

Grants:
- `src-tauri/capabilities/default.json` adds exactly `allow-layer-wifi-connections`, `allow-layer-bluetooth-connected`, `allow-layer-location`, `allow-layer-passkey-get`, `allow-layer-passkey-create` and `allow-open-location-settings`.
- `build.rs` adds the six command names, and `lib.rs` registers them.

## 11. Client platform contract (TypeScript, area D)

`src/platform/native.ts` (new). These wrappers over `@tauri-apps/api/core` `invoke` are imported dynamically, like the opener. Each validates the Rust output strictly: non-finite numbers, empty strings and unknown fields throw a `NativeLayerError`.

```ts
export type NativeErrorCode = 'unsupported-platform' | 'location-consent-required' | 'wifi-unavailable' | 'not-connected'
  | 'bluetooth-unavailable' | 'location-unavailable' | 'accuracy-unknown' | 'invalid-request' | 'passkey-cancelled' | 'passkey-failed';
export class NativeLayerError extends Error { constructor(readonly code: NativeErrorCode, message: string) }
export interface NativeWifiConnection { ssid: string; ssidHex: string; bssid: string }
export interface NativeBluetoothDevice { id: string; name: string; kind: 'classic' | 'le' }
export interface NativeLocation { lat: number; lng: number; accuracyM: number; at: number }
export function nativeWifiConnections(): Promise<NativeWifiConnection[]>;
export function nativeConnectedBluetooth(): Promise<NativeBluetoothDevice[]>;
export function nativeLocation(): Promise<NativeLocation>;
export function nativePasskeyGet(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
export function nativePasskeyCreate(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
export function openLocationSettings(): Promise<void>;
```

The WebAuthn JSON types come from `@simplewebauthn/browser`. The wrappers map options to the Rust request:
- `allowCredentials[].id` → `allowCredentials`
- `timeout` → `timeoutMs`
- `user.id` → `userId`

`src/platform/layers.ts` (new):

```ts
export interface LayerCapabilities {
  surface: 'desktop' | 'extension' | 'web';
  passkey: 'native' | 'browser' | 'none';          // tauri → native (Windows), extension/web → browser if PublicKeyCredential exists
  geolocation: 'native' | 'browser' | 'none';
  bluetooth: 'native' | 'web-bluetooth' | 'none';  // web-bluetooth only if navigator.bluetooth?.requestDevice exists
  wifiRadio: boolean;                              // tauri on Windows only
  ceremonyInline: boolean;                         // false in the extension side panel (extensionSurface() === 'sidepanel') until verified on real Chrome
}
export function layerCapabilities(): LayerCapabilities;
/** Extension only: opens wallet.html<route> in a tab and closes the side panel (same behaviour as the existing "Open in full tab" bar). Returns false outside the extension. */
export function openWalletTab(route: `#${string}`): Promise<boolean>;
```

`src/extension/sidepanel.tsx` reuses `openWalletTab` for its bar.

## 12. Client flows (area B)

**Approval**, inside `PairedSolanaVault.completeRelease(index)`:
1. Call `requestGuardianApproval(token, multisig, index)` **without** evidence. If it answers `approved`, `pending` or `already-approved`, continue as today. On `403 layers-required`, go to step 2.
2. If `!layerCapabilities().ceremonyInline`, show "Approve in a full tab". It calls `openWalletTab('#vault')`, and the tab resumes from the existing proposal resume key with "Continue release". Stop here in the panel.
3. Call `beginLayerApproval`. Then compare `begin.release` with `readPairedSolanaProposal(...)` on this device: index, asset, `amountRaw` and recipient. **Any difference aborts** with "The server described a different release. Nothing was approved."
4. Show the `LayerApproval` panel: each required layer with its kind badge and checked-by line. One button, **Verify and approve**, provides the user gesture.
5. Collect, in this order:
   1. Bluetooth (`requestDevice` needs the gesture, so it goes first)
   2. geolocation
   3. Wi-Fi radio
   4. passkey (last, so the user-verification prompt is the final step)

   A collector error stops the flow with its message. Nothing is sent.
6. If any reading is required, build `DevicePayloadV1` and sign it with this device's key. A missing key means "This device isn’t trusted for this vault yet. Set it up with your passkey, then try again.", with a **Set up this browser** / **Set up this computer** action (it opens the set-up sheet; turning on a layer that reads from this device, and activation, set it up as an announced step, see below).
7. Send `requestGuardianApproval(token, multisig, index, {challengeId, passkey?, device?})`.
   - `layer-failed`: show the per-layer reasons.
   - `challenge-stale`: restart from step 3, once.
   - `locked`: show the retry time.

**Pending changes outside settings.** ANTARA sends no notifications (O7), so while a recovery change is pending (a loosening applies at once since 2026-10-13, so only a recovery can be pending), the vault summary and the `LayerApproval` panel show a persistent warning in fixed text ("A change that weakens this vault's protection takes effect on <date> (recovery: waives Biometrics)"), never the change's summary or label, with **Review or cancel** leading to the Pending changes list.

**Enrollment and changes** (the `VaultLayers` panel, on the Protection page and in vault settings; owner feedback 2026-10-13 "simple for the user"):
- One list (`LayerList`, view model `rows.ts`), required layer first: Biometrics, Safe Zones, Wi-Fi, Bluetooth, MFA, Limits. Each row: icon, name, a pill from the server's answer (`On`, `On · Required`, `Off`, `Required`, `Turning off`, `Waiting`), one short line (what the layer does, or what is set) and **one** action (`Turn on`, `Add a passkey` or `Manage`). A layer this app cannot use, or any layer before the first passkey, has no button and one muted line saying why; there is never a disabled button. No kind badges in the list.
- Below the list: **Pending changes** (only when there are some), then two folds: **Your devices** (only once a device is set up; with Remove and the trusted-device claim) and **How protection works** (the §14 claims). There is no standalone "trust" button.
- On the Protection page, the list sits in the first viewport under one slim summary strip (count, six-segment meter, at most one next step); the status planet is a small decorative thumbnail in the strip at 1280 px and wider only.
- Each action opens one sheet, anchored near the top on desktop, with its main action pinned in the sheet footer (forms submit through the button's `form` attribute; footers are keyed per screen so a click that opens a form can never submit it). **How ANTARA checks this** (collapsed) carries the kind in plain words, the exact checked-by lines from [section 14](#14-honest-claims), the synced-passkey line when a synced passkey is listed, the trusted-device line when the flow sets this device up, and each item's raw server detail (Manage sheets otherwise show the name and "Added <date>").
- **Turn on** is one guided flow (`setup.ts`): at most three visible steps, e.g. *Set up this browser* (Passkey prompt 1 of 2) → *Share your location* → *Confirm with your passkey* (Passkey prompt 2 of 2) → "Safe Zones is on". A form with one step shows one line instead of a list. Only a change that itself reads from this device (`readsFromDevice`: a safe zone, a Bluetooth device, a Wi-Fi name or access point), whose form lists the set-up step before anything starts, runs `device.add` first in the same sheet when this device is not trusted, then begins the change again (its challenge must list the new key). Any other change whose challenge needs a reading from an untrusted device (for example turning a layer off while Safe Zones is on) stops before any prompt with "One step first" and a **Set up this browser** button: setting the device up is then the user's own click (security review 2026-10-13). Each change keeps its own single-use challenge and its own passkey assertion: two prompts plus the one-time location permission for Safe Zones on an untrusted device. No server rule changed.
- Tightening and loosening apply at once, so the flow finishes without a second click unless the user must give something: a 6-digit code, a choice (Desktop Bluetooth device, Wi-Fi network), the click Chrome's Bluetooth chooser needs, or consent to a recovery change. A change that waits shows which change it is and what it waives ("Set up this browser · waives Bluetooth"), then its effective time, before **Confirm**. **Continue** is never disabled: pressing it without the code says "Enter the 6-digit code from the app." Removing an item or turning a layer off asks for confirmation first.
- A step that fails shows a calm card with **Try again** (a fresh begin; a device set up on the way stays set up). If evidence for an enabled layer cannot be collected here, the card offers a waiver named for the change it belongs to ("Waive Bluetooth to set up this browser (7 days)", "Waive Safe Zones to turn off Wi-Fi (7 days)") and says what that means. While a tightening change waits for the user (turning a layer on), no waiver is offered.
- Activation's passkey step adds the first passkey, then sets this device up in the same step (a second passkey prompt; the step says "Your device will ask twice", with the biometrics and trusted-device lines under **How ANTARA checks this**). That is never fatal: if it fails, the first layer that reads from the device sets it up.

Collector details:
- **Safe Zones (browser):** `getCurrentPosition` with `{enableHighAccuracy:true, maximumAge:0, timeout:15000}`. Reject non-finite values and `accuracy <= 0`. `at = position.timestamp`.
- **Web Bluetooth:**
  - Enrollment uses `requestDevice({acceptAllDevices:true})`.
  - Approval uses `requestDevice({filters: match.filter(surface).map(d => ({name: d.name}))})`.
  - The identifier is `device.id`. Never use `getDevices()`.
  - Adding a device while Bluetooth is on (§8.1) takes two clicks, because each chooser needs its own user gesture: **Find your trusted device** (the approval chooser), then **Choose your device** (`acceptAllDevices` for the new device). Both devices go in one signed reading.
- **Passkeys (browser):** `startRegistration` / `startAuthentication` from `@simplewebauthn/browser`, with `optionsJSON` from the server. Desktop uses `nativePasskeyCreate` / `nativePasskeyGet`.
- **Wi-Fi radio:** `nativeWifiConnections()`. On `location-consent-required`, show "Allow location access for desktop apps in Windows Settings (Wi-Fi names are location data in Windows 11)", with a button that calls `openLocationSettings()`.

## 13. Implementation plan: four disjoint areas

Each area edits **only** its listed files. Contracts between areas are sections 6, 9, 10 and 11, used verbatim. No area commits, pushes or changes branches. The integration pass (§13.5) wires everything together, runs all checks and updates the docs.

### 13.1 Area A: server engine

Files:
- `server/src/solares/layers/**` (new)
- `server/src/solares/vaultPolicy.ts`
- `server/src/solares/vaultStore.ts`
- `server/src/solares/guardian.ts`
- `server/src/solares/pairedVault.ts`
- `server/src/solares/wallet.ts`: add `sessionId` from `verifyAccessToken().session_id` to `SolaresUser`; nothing else
- `server/src/solares/*.test.ts`
- `server/package.json`: test script only

| File | Contents |
|---|---|
| `layers/types.ts` | `LayerId`, `OptionalLayerId`, `Surface`, the records in §5.1, `ChangeOp`, `LayerRequirement`, `LayerEvidence`, `DevicePayloadV1`, and the constants: TTL 5 min, loosen immediate (2026-10-13), recovery 7 d, retry 30 min, 5 pending changes, lockout 5 failures in 15 min, the item caps, radius bounds, prefix bounds, payload sizes |
| `layers/config.ts` | `layerServerConfig(env)`: RP ID, origins and the origin→surface map. Throws `GuardianError(503)` naming the variable, never its value. |
| `layers/digest.ts` | `releaseDigest`, `changeDigest`, `normaliseOp`, `webauthnChallenge` |
| `layers/challenges.ts` | The in-memory store from §5.2 (`issue`, `take`, sweep and caps; injectable clock) |
| `layers/lockout.ts` | Failure counting and the lock check |
| `layers/passkey.ts` | `creationOptions`, `requestOptions`, `verifyRegistration` and `verifyAssertion` over `@simplewebauthn/server` 13.3.x. These return facts (`credentialId`, `newCounter`, `surface`, `deviceType`, `backedUp`) or throw. |
| `layers/device.ts` | SPKI import (P-256 only), `keyIdOf`, `verifyDevicePayload` (signature first, then a strict schema parse) |
| `layers/network.ts` | `observedPublicIp(reqIp, {production, trustProxy})`, `normaliseCidr`, `cidrContains`, masking |
| `layers/geo.ts` | `haversineM`, `zoneCheck` |
| `layers/policy.ts` | `requiredEvidence`, `evaluateLayers`, `classifyChange`, `applyChange`, `effectiveConfig`, `describeLayers` (for GET), `effectiveReleaseLimits` (or put it in `vaultPolicy.ts`) |
| `layers/service.ts` | `createVaultLayerService(deps)`: list, enroll begin/finish, change begin/finish, cancel, approval begin. Reuses the guardian's `loadUser`, `readReleaseSnapshot`, `evaluateRelease` and store lock. |
| `layers/testAuthenticator.ts` | **Test-only** software authenticator (`node:crypto` P-256, `isoCBOR`). It produces RegistrationResponseJSON and AuthenticationResponseJSON with chosen flags (UV on or off), counter, origin and RP ID. Never imported by application code. |
| `vaultStore.ts` | Version 2 document, validation, `layerConfig(multisig)`, `writeLayerConfig(multisig, expectedVersion, next)` (optimistic, conflict throws), and `LedgerEntry.layers` |
| `vaultPolicy.ts` | `effectiveReleaseLimits`. `evaluateRelease` is unchanged except that it receives the effective limits. |
| `guardian.ts` | `approve(privyUserId, body, context: {ip: string \| null; sessionId: string})` with the ordering in §7. A `layers` sub-service on `PairedVaultGuardian`. `limits(privyUserId, multisig?)` returns the effective vault limits when given a multisig. `GuardianError` codes and `extra` (§9). |
| `pairedVault.ts` | The routes in §9, passing `clientIp(req)` and `req.solaresUser.sessionId`, the `layers-write` limiter, the 16 KB evidence guard, and the `extra` passthrough |

Tests (`npm.cmd --prefix server test`; add `src/solares/layers/*.test.ts` to the server test glob):

- `digest`: fixed vectors for both digests and both WebAuthn challenges. These pin the strings in §6; B copies the hex values into its fixtures.
- `challenges`:
  - single use: a second `take` returns null
  - expiry at TTL
  - per-user and global caps
  - a foreign user or session is refused
- `passkey`, with the test authenticator:
  - pass
  - UV flag off
  - wrong origin, wrong RP ID
  - wrong challenge, including one for another digest and a `create` challenge used for `get`
  - counter regression
  - an unknown credential, and a pending-addition credential
  - a registration with UV off
- `device`:
  - pass
  - a P-384 or RSA key refused
  - a bad signature
  - one flipped payload byte
  - unknown fields
  - NaN, Infinity
  - a mismatch in nonce, digest, purpose or `keyId`
  - surface and source mismatches
  - stale or future timestamps
  - oversize payloads
- `geo`:
  - inside, outside
  - accuracy exactly radius/2, and above it
  - `accuracyM` 0, missing or NaN
  - the antimeridian and the poles
  - several zones
- `network`:
  - IPv4 and IPv6 matching
  - IPv4-mapped IPv6
  - private, loopback and CGNAT addresses refused
  - `TRUST_PROXY` false in production, with no `CLIENT_IP_HEADER`, gives null
  - prefix bounds
- `policy`: the full classification table in §8.1, row by row. Also: waive rules (2026-10-13: any enabled evidence layer, MFA included; Limits is never waived, only turned off), recovery delay, `effectiveConfig` applying due changes in order, pending items never usable, the 5-pending cap, and `limits.set` bounds.
- `vaultStore`:
  - a version 1 document read as no layers
  - version 2 round trip
  - every invalid layer field refused
  - an empty item list refused
  - version conflict
  - a missing document with the marker present still refuses
- `guardian`, with faked Privy and RPC:
  - no layers: today's behaviour unchanged
  - `layers-required` reserves nothing
  - the full pass votes once
  - each layer failing alone denies and reserves nothing
  - a replayed challenge is `challenge-invalid`
  - a changed transaction account after begin is `challenge-stale`
  - a config change after begin is `challenge-stale`
  - the retry within 30 minutes of a passed reservation re-signs without evidence; after 30 minutes or a version change it needs evidence
  - lockout after 5 failures
  - the counter is persisted
- `pairedVault` routes:
  - `401` before every new route
  - `503 not-provisioned` while switched off
  - GET masking (no center, no full IP, BSSID or identifier)
  - every begin and finish happy path
  - loosen applies at once after every enabled layer passes; recovery gives pending and later applies
  - cancel
  - tighten requires a passkey when biometrics is enabled
  - the 16 KB guard
  - the `extra` passthrough limited to the defined shapes
  - audit lines contain no readings (assert on captured lines)

### 13.2 Area B: client collectors and UI

Files:
- `src/solares/layers/**` (new)
- `src/solares/vaults/PairedSolanaVault.tsx`
- `src/solares/vaults/pairedApi.ts` (and its test)
- `src/solares/protection/**`
- `src/solares/landing/protectionLayers.ts`
- `tests/browser/vault-layers.spec.ts` (new)
- `tests/fixtures/wallet.tsx`: replace `SolanaFixtureWallet` with a valid base58 address, which also closes GUARDIAN.md item 8's blocker

| File | Contents |
|---|---|
| `layers/types.ts` | Client mirrors of §9 |
| `layers/api.ts` | `fetchVaultLayers`, `beginLayerApproval`, `beginEnroll`, `finishEnroll`, `beginChange`, `finishChange`, `cancelChange`. Strict parsers that refuse: unknown layer IDs, kinds or statuses; `enforced:true` with `not-enrolled` for an optional layer; anything but six layers in landing order; unmasked-looking values (a full IPv4 address, or a 12-hex identifier in `detail`). Reuses the `call` helper, which `pairedApi.ts` exports. |
| `pairedApi.ts` | `requestGuardianApproval(token, multisig, index, layers?)`, and `PairedVaultApiError` carrying `required` and `layers` for the new codes |
| `layers/deviceKey.ts` | Section 5.3, with a storage interface (IndexedDB in the app, in-memory in tests) |
| `layers/collectors.ts` | Safe Zones, Bluetooth, Wi-Fi and passkey collectors per `layerCapabilities()`, following §12 |
| `layers/evidence.ts` | `buildDevicePayload` (exact field set), base64url, `assertReleaseMatches(begin.release, proposal)` |
| `layers/claims.ts` | The kind badges and the honest-claims table (§14) as constants; the UI reads only from here |
| `layers/VaultLayers.tsx`, `layers/LayerApproval.tsx`, `layers/layers.css` | The UI from §12. Black and charcoal, selective blue, Space Grotesk and Inter; no decorative SVG art; keyboard and screen-reader labels. |
| `PairedSolanaVault.tsx` | The layer step in `completeRelease`, the `VaultLayers` panel in vault settings, the full-tab hand-off, and `CLAIMS` extended from `claims.ts` |
| `protection/ProtectionWorkspace.tsx` | An entry "Vault protection layers → open your vault". **No status** there unless it comes from `GET /solana/layers`. |
| `landing/protectionLayers.ts` | Change the `status` strings only after the integration pass confirms that A to D landed. Use the exact strings in §14.3. |

Tests:
- **Unit:** `src/solares/layers/*.test.ts` (area D adds the glob to `test:unit`).
  - The parsers accept the §9 examples and refuse each malformed variant.
  - `buildDevicePayload` produces the exact §6.3 field set.
  - A device key created through Node WebCrypto signs a payload that `node:crypto` verifies with `dsaEncoding:'ieee-p1363'`. This proves compatibility with A.
  - `assertReleaseMatches` refuses each field difference.
  - The collectors refuse NaN, missing or zero accuracy, a timeout and a missing API.
  - The claims table covers all six layers.
- **Browser** (`tests/browser/vault-layers.spec.ts`, mocked routes): not-provisioned shows no layer status; a GET failure shows no layer status; enrolled, not-enrolled, pending-removal and pending-addition states; `layers-required` opens the approval panel; a server release summary that differs from the on-device proposal aborts before any ceremony; `layer-failed` reasons render; a cancelled pending change disappears; and nothing says "active", "enforced" or "verified" when the route is not `200`.

### 13.3 Area C: native Rust

Files:
- `src-tauri/**`, including `Cargo.toml` (feature `Win32_NetworkManagement_WiFi`), `build.rs`, `src/lib.rs`, new `src/layers.rs`, new `src/layer_passkey.rs` (plus a non-Windows stub, following the `webauthn_unavailable.rs` pattern), `src/devices.rs` (the legacy `get_location` accuracy fix only), `capabilities/default.json`, and the regenerated `permissions/autogenerated/*`
- `scripts/check-desktop-build.mjs` and its test

Tasks:
- the commands in §10, exactly
- pure helpers kept separate from the FFI so they can be tested: `format_bssid`, `ssid_from_dot11`, `map_wlan_error`, `validate_passkey_request`, `client_data_json`, `map_webauthn_error`, `allowed_rp_ids()`
- in `check-desktop-build.mjs`:
  - assert the six new grants
  - keep `webauthn_make_credential` and `webauthn_get_assertion` denied
  - add a check that no capability grants a `layer_*` command to any webview but `main`

Tests:
- `cargo test` in `src-tauri`, on Windows plus the non-Windows stubs:
  - BSSID formatting
  - SSID bytes, including non-UTF-8 and the 32-byte maximum
  - error 5 maps to `location-consent-required`
  - passkey request validation refuses an RP ID outside the allowlist, `example.com`, an empty RP ID, a 31- or 33-byte challenge, invalid base64url, an empty `allowCredentials` and an out-of-range timeout
  - `client_data_json` escapes correctly and fixes the field order and origin
  - stubs return `unsupported-platform`
  - the legacy `get_location` never yields `accuracy 0.0`
- `node --test scripts/check-desktop-build.test.mjs`, and `npm.cmd run check:desktop`
- No interactive window; the hardware checks are in [section 15](#15-manual-hardware-acceptance-owner-run-only-when-requested).

### 13.4 Area D: extension and platform

Files:
- `extension/manifest.ts`, `extension/policy.mjs` (+ `.d.mts`), `extension/EXTENSION_ID.md` (permission docs)
- `scripts/extension-check.mjs`
- `src/platform/**`, including new `native.ts` and `layers.ts`
- `src/extension/**`
- `tests/extension/**`
- `package.json`: the `test:unit` glob gains `src/solares/layers/*.test.ts` and `src/platform/*.test.ts` (already present)

Another workflow may be editing extension config concurrently. Re-read these files right before editing, and never revert changes made by others.

Tasks:
- `EXTENSION_PERMISSIONS = ['sidePanel', 'geolocation']`
- `minimum_chrome_version: '122'`
- `extension-check.mjs` allows exactly that permission set, and fails if `minimum_chrome_version` is below 122 or if `optional_permissions` appears
- §11 in full; `sidepanel.tsx` uses `openWalletTab`

Tests:
- **Platform unit tests:**
  - `layerCapabilities()` for tauri, extension side panel, extension tab and web, with stubbed globals
  - the `native.ts` wrappers refuse malformed Rust output (NaN, empty SSID, a lowercase or short BSSID, a missing `accuracyM`) and map error strings to codes
- **`tests/extension/extension.spec.ts`**, headless Playwright Chromium, which must be version 122 or later:
  - The manifest permissions equal `['sidePanel','geolocation']`, and the minimum version is 122.
  - In `wallet.html`, using a CDP `WebAuthn.enable` + `addVirtualAuthenticator` (`ctap2`, internal, UV true): `navigator.credentials.create` with `rp.id: 'antara.tech'` **succeeds**, and with `rp.id: 'example.com'` it **fails** with `SecurityError`. `clientDataJSON.origin` equals the extension origin. This proves finding (b) automatically.
  - With CDP `Emulation.setGeolocationOverride`, `navigator.geolocation.getCurrentPosition` resolves in the extension page with no prompt.
  - `typeof navigator.bluetooth?.requestDevice === 'function'` in the extension tab. The chooser itself is manual.
  - The side-panel document gets `layerCapabilities().ceremonyInline === false`.

### 13.4a Deviations recorded by the integration pass

- The area B browser tests live in `tests/browser/wallet.spec.ts` (with `tests/fixtures/layers.{html,tsx}`), not a separate `vault-layers.spec.ts`.
- Server layer tests live in `server/src/solares/vaultLayers.test.ts` and the layer section of `pairedVault.test.ts` (the existing server test glob), not `src/solares/layers/*.test.ts`.
- The extension's "side panel" tests load `sidepanel.html` as a document in an ordinary tab (headless Playwright cannot open Chrome's side-panel host); the real side panel stays on the §15 list.
- **Added:** `src/solares/layers/endToEnd.test.ts` runs the shipped client flow code against the real server routes over HTTP (`server/src/solares/layers/testHarness.ts`, test only), and pins the client fixtures against the server's own digest code.
- **Added:** `scripts/extension-check.mjs` counts `getCurrentPosition` call sites in a built package (at most `GEOLOCATION_CALL_SITES` = 1, the vault collector) and refuses any `watchPosition`; `scripts/check-test-globs.mjs` fails `test:unit` and `test:config` when a test pattern matches no file.

### 13.5 Integration pass (after A to D; not one of the four)

1. Run `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run test:extension`, `npm.cmd run test:e2e`, `cargo test --manifest-path src-tauri/Cargo.toml` and `npm.cmd run check:desktop`.
2. Fix contract mismatches by editing whichever area's file is wrong.
3. Update the docs:
   - `docs/GUARDIAN.md`: flows, "What the server enforces", honest claims, known limits, and remove "Limits are global"
   - `docs/SECURITY.md`
   - `docs/VERIFICATION.md`: the evidence above and the hardware checks still open
   - `docs/HANDOFF.md`
   - this file's status line
   - optionally `scripts/doctor.mjs` (names only)
4. Do not set `ANTARA_PAIRED_VAULTS_ENABLED`.

## 14. Honest claims

### 14.1 The UI and docs may say (only while `GET /solana/layers` answers 200 and the layer is enrolled)

| Layer | Kind badge | "Checked by" line (exact) |
|---|---|---|
| All | none | "ANTARA's guardian votes only after every layer you turned on passes for this exact release. Layers are checked by ANTARA's server; a compromised ANTARA server could skip them." |
| Biometrics | Cryptographic | "Your device verifies you (fingerprint, face or device PIN) and signs this exact release. ANTARA checks the signature. ANTARA never receives biometric data." |
| Biometrics (synced passkey item) | none | "Synced passkey: any device signed in to your passkey provider can use it." |
| MFA | Cryptographic | "ANTARA checks a 6-digit code from your vault authenticator app with this exact release. Each code works once. The app’s secret is stored encrypted on ANTARA’s server, so a compromised ANTARA server could read it." |
| Safe Zones | Device-reported | "Your trusted device reports where it is and signs the reading. ANTARA checks that it falls inside a safe zone. A modified device or location spoofing can fake this signal." |
| Wi-Fi (network) | Server-observed | "ANTARA checks the public internet address your request comes from. Anyone on the same network, or a VPN that exits there, shares that address." |
| Wi-Fi (radio, desktop) | Device-reported | "ANTARA Desktop reports the Wi-Fi name and access point it is connected to. Your device reports this; ANTARA cannot verify it." |
| Bluetooth (desktop) | Device-reported | "ANTARA Desktop checks that your trusted Bluetooth device is connected to this computer. Distance is not measured." |
| Bluetooth (extension or web) | Device-reported | "You pick your trusted device from the Bluetooth devices Chrome finds nearby. Distance is not measured." |
| Limits | Cryptographic | "ANTARA co-signs only single SOL or USDC releases to your own wallets, within the caps you set." |
| Trusted devices | Cryptographic | "Readings are signed with a key created on this device. ANTARA cannot export it, but it is stored in this app's or browser's profile, not in secure hardware." |
| Changes | none | "Turning a layer on or tightening it takes effect immediately. Turning one off or loosening it also takes effect immediately, but needs every layer you have on. Recovery without a layer takes 7 days, and you can cancel it until then." |
| Notifications | none | "ANTARA does not send notifications about pending changes. Check this screen." |
| Session recovery (implementation) | none | "Someone holding your session can add a passkey through recovery; it takes effect after 7 days unless you cancel it, and can then be used to remove your original passkey." |

MFA keeps the **Cryptographic** badge (owner decision O5). Since 2026-10-13 ANTARA's server verifies the code itself (HMAC-based RFC 6238 against the sealed secret), so D4 no longer applies. The station label after an approval is "Passed · code checked".

### 14.2 Never claim

- that a fingerprint or face scan is required (a device PIN can satisfy user verification)
- per-transaction MFA, or that ANTARA verified a fresh MFA code
- "verified location", "GPS verified", "cannot be spoofed", or any geofence guarantee
- "Wi-Fi verified" on the extension or web (only the public IP is observed there)
- a Bluetooth distance in metres, or "proximity verified"
- hardware-backed or TPM device keys
- that a desktop passkey approval proves ANTARA (rather than another local program) asked for it, or that the `https://tauri.localhost` origin identifies ANTARA. It binds the user's verification to the exact release challenge; any local program can show the same Windows Hello prompt for `antara.tech`.
- a layer as active, enforced or on when the route failed, answered `not-provisioned`, or the layer is `not-enrolled`
- protection against a compromised ANTARA server
- that an extension origin (`chrome-extension://…`) or a passkey's origin identifies ANTARA's code: a sideloaded extension can copy the public key and its origin, and local native code can claim any origin (§3)
- that Safe Zones on the extension or web refuses a spoofed or default location (`navigator.geolocation` reports no source; only ANTARA Desktop applies the measured-source rule)
- that funded acceptance or hardware acceptance passed, until it is recorded in `docs/VERIFICATION.md`
- voice, USB or other ARGUS factors (not offered)

### 14.3 Landing `status` strings

Apply these after integration. They keep the "not live" wording until the owner switch and acceptance are done.

| Layer | `status` |
|---|---|
| Bluetooth | "Paired-vault layer · device-reported · not live yet" |
| Wi-Fi | "Paired-vault layer · public network check, Wi-Fi name on Desktop · not live yet" |
| Biometrics | "Paired-vault layer · passkey verified by ANTARA · not live yet" |
| Safe Zones | "Paired-vault layer · device-reported · not live yet" |
| MFA | "Optional vault authenticator: a 6-digit code for each release · not live yet" |
| Limits | "Paired-vault layer · optional caps you set, enforced by the guardian · not live yet" |

## 15. Manual hardware acceptance (owner-run, only when requested)

None of this runs automatically. Record every result in `docs/VERIFICATION.md`.

1. **Desktop, packaged build:**
   - Windows Hello passkey enrollment and assertion through `layer_passkey_*`.
   - A phone passkey through the hybrid QR.
   - The location consent prompt and a reading inside and outside a zone.
   - That the consent prompt appears when `RequestAccessAsync` runs on the main thread (no `RPC_E_WRONG_THREAD` or other failure). If it never appears, record it; the command still refuses a fix without consent (`E_ACCESSDENIED` → `location-consent-required`).
   - That a fix whose source is the Windows default location (Wi-Fi off, Settings > Privacy & security > Location > Default location set inside the zone), and a fix over Remote Desktop, are both refused as `location-unavailable`.
   - Wi-Fi consent on Windows 11 24H2 or later, with an SSID and BSSID match.
   - A classic Bluetooth device connected, then disconnected.
2. **Extension:**
   - A passkey ceremony in the **side panel**. If it works, area D sets `ceremonyInline` to true for the side panel in a follow-up.
   - A passkey ceremony in the full tab.
   - The Web Bluetooth chooser in the side panel and in the tab.
   - Safe Zones in the side panel.
   - That a passkey enrolled on desktop with Windows Hello is offered in Chrome. A passkey saved to Google Password Manager is not visible to the desktop app; the UI explains this.
   - Withdraw the extension's site access to `antara.tech` in Chrome, then retry a passkey ceremony: it is expected to fail (closed). Not verified yet.
3. **Web:** a passkey, Web Bluetooth (Chrome and Edge) and the geolocation prompt.
4. **Network:** the trusted-network IP from Cloudflare's `CF-Connecting-IP` through the Render proxy. A VPN is refused.
5. **Changes and recovery:** a loosening change applies at once only after every enabled layer passes, and a 7-day recovery change can be cancelled within its window. (Automated in `endToEnd.test.ts`; the real-device check is still open.)
6. **Activation window:** a first passkey added from the activating app within 15 minutes applies at once; one added later shows as a 7-day recovery change on the vault card.

## 16. Owner decisions

| # | Decision | Default in this spec |
|---|---|---|
| O1 | Recovery: changes that waive a layer the user can no longer satisfy | Allowed for every optional layer, including biometrics, with a 7-day delay. The alternative is no recovery: the vault is stuck, like a lost login today. |
| O2 | Extension `geolocation` permission (install warning "Detect your physical location"; cannot be optional) | Add it before the first Web Store submission |
| O3 | Extension minimum Chrome version | 122 |
| O4 | Server-side coarse IP geolocation (DB-IP Lite, CC BY 4.0, about 121 MB monthly, attribution and link required) | Not in v1 |
| O5 | Badge naming for MFA and Limits | Use the owner's three kinds, with precise "checked by" lines. "Privy-enforced" and "Guardian-enforced" badges would be more literal. |
| O6 | Require a passkey for every new vault | **Decided by the owner: yes.** A vault is not active until a passkey is in force, every release needs it, Biometrics cannot be turned off and the last passkey cannot be removed. The first passkey applies at once only from the activating session within 15 minutes; otherwise it is a 7-day recovery change. |
| O7 | Notifications for pending loosening or recovery changes | None in v1 (in-app only). The vault card and the release panel show a persistent warning, in fixed text, while one is pending. |

Open decisions raised by the implementation review (2026-10-13). The build implements the default in the last column; nothing here is decided yet.

| # | Decision | Current behaviour |
|---|---|---|
| D1 | Should a recovery that waives Biometrics also need one non-waived factor (a trusted-device signature, or the trusted network), or out-of-band notifications? Requiring a factor would leave a user who lost everything unrecoverable. | Session plus TOTP enrollment (no code) can schedule it; 7 days, visible and cancelable in the app; recovery-added items are marked, and removing the owner's original passkey or device afterwards is a loosening: it applies at once but needs every enabled layer. |
| D2 | Cost of a missed activation window | The first passkey becomes a 7-day recovery change. A shorter wait is the alternative. |
| D3 | Adding a new app (surface) while Bluetooth is on | Refused before any ceremony, with a "waive Bluetooth (7 days)" offer; adding that app's Bluetooth device can need a second recovery. Alternatives: a reading co-signed by an already-trusted app, or keep and document. |
| D4 | MFA badge | "Cryptographic" with a checked-by line saying ANTARA checks enrollment only. A "Privy-enforced" or "Server-observed" label needs a matching client and server change. |

## 17. Sources

- Chrome extensions can claim RP IDs for host-permission sites from Chrome 122 (Chrome team, public-webauthn, December 2023): https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html
- WebAuthn Level 3, §5.11.1 Validating Related Origins: https://www.w3.org/TR/webauthn-3/#sctn-validating-relation-origin
- passkeys.dev, Related Origin Requests (file location, 5-label limit): https://passkeys.dev/docs/advanced/related-origins/
- Chrome ROR announcement (Chrome 128): https://developer.chrome.com/blog/passkeys-updates-chrome-129
- WebView2Feedback #5663 (WebAuthn and Windows Hello not working in WebView2): https://github.com/MicrosoftEdge/WebView2Feedback/issues/5663
- `WebAuthNAuthenticatorGetAssertion`: https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthn-webauthnauthenticatorgetassertion
- Changes to API behavior for Wi-Fi access and location (Windows 11 24H2): https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes
- Chrome extensions, geolocation: https://developer.chrome.com/docs/extensions/mv3/geolocation
- Chrome permissions API (permissions that cannot be optional): https://developer.chrome.com/docs/extensions/reference/api/permissions
- Chrome permission list (geolocation warning): https://developer.chrome.com/docs/extensions/reference/permissions-list
- Web Bluetooth in extensions (Web Bluetooth CG log, September 2023): https://lists.w3.org/Archives/Public/public-web-bluetooth-log/2023Sep/0004.html
- Privy MFA overview: https://docs.privy.io/authentication/user-authentication/mfa/overview
- DB-IP IP to City Lite: https://db-ip.com/db/download/ip-to-city-lite
- Third-party report that ceremonies in an extension side panel can hang (unverified; the reason for the full-tab default): https://mera.category.xyz/recipes/use-mera-with-chrome-extensions/
- Installed code checked:
  - `server/node_modules/@simplewebauthn/server` 13.3.3
  - `node_modules/@simplewebauthn/browser` 13.3.0
  - `server/node_modules/@privy-io/node` 0.35.0 (`resources/users/users.d.ts`, `lib/auth.d.ts`)
  - the `windows` 0.58.0 crate source (`Win32/NetworkManagement/WiFi`)
  - `src-tauri/src/{devices,webauthn,lib}.rs`, `src-tauri/capabilities/default.json`, `scripts/check-desktop-build.mjs`
  - `extension/{manifest.ts,policy.mjs}`
  - `server/src/solares/{vaultPolicy,vaultStore,pairedVault,guardian,wallet}.ts`
