# ANTARA in one page

Updated October 13, 2026. This is the plain-language product model. Technical
detail lives in [GUARDIAN.md](GUARDIAN.md), [VAULT_LAYERS.md](VAULT_LAYERS.md),
[RELAY.md](RELAY.md) and [SECURITY.md](SECURITY.md); where they and the code
disagree with this page, the code wins. The public version of this page is the
docs site at `/docs` (`src/solares/Guide.tsx`, `src/solares/docs/`).

## The model

> You have a regular wallet, and with that wallet you create a multisig vault
> that lets you place security layers. That is the whole point of ANTARA.

1. **Wallet.** Sign in with email (Privy). ANTARA creates an embedded Solana
   wallet and an embedded EVM wallet; external wallets can also connect (in the
   Chrome extension, expected to be WalletConnect only; not yet verified). The
   wallet is the everyday side: balances, receive (QR), send, and swaps through
   Relay. The vault's layers do not apply to it, and there is
   **no MFA on the regular wallet** (owner decision 2026-10-13: ANTARA does not
   use Privy wallet MFA and no longer reads Privy `mfa_methods`).
2. **Vault.** From the wallet you create a vault (Vault is a main destination:
   sidebar or bottom tab, and the home "Your vault" card, both with **Create
   vault**): a Squads v4 2-of-2 multisig on
   Solana. Its members are your wallet (propose, vote, execute) and ANTARA's
   guardian (vote only), threshold 2, no configuration authority, no spending
   limits, no on-chain time lock. It holds SOL and USDC and releases only to your
   own wallets.
3. **Layers.** The guardian votes on a release only when every security layer
   you turned on passes for that exact release.

## Where it runs

Solana first, then Ethereum, BNB Smart Chain, Robinhood Chain and Base, in three
apps on one account: ANTARA Desktop (Windows, Tauri), the Chrome extension (side
panel, full tab when a passkey or Bluetooth prompt is needed) and the web app at
`antara.tech/app`.

## The wallet

| Network | Funding stablecoin (what swaps are paid from) |
|---|---|
| Solana | USDC (Circle) |
| Ethereum | USDC (Circle) |
| BNB Smart Chain | USDC (Binance-Peg), 18 decimals, issued by Binance |
| Robinhood Chain | USDG (Paxos Global Dollar); no Circle USDC there |
| Base | USDC (Circle) |

- **Balances:** the top of the wallet, and of the vault, is the total of what it
  holds in US dollars, "≈ $8.43" (owner decision 2026-10-13). Prices are current
  Relay prices read through ANTARA's API (`GET /api/solares/wallet/prices`, about
  once a minute) and labelled with the source and time. An asset without a price
  is named as excluded; with no prices at all the top shows the largest holding
  as a token amount, never "$0". Token rows and token detail show each asset's
  value and price. No 24-hour change, no PnL, USD only.
- **Send:** the native coin or the funding stablecoin, after a simulated review
  of the full address and fee.
- **Swap:** from the funding stablecoin, through Relay. ANTARA sets no swap cap
  (owner decision 2026-10-13); the only bound is the protocol sanity ceiling of
  100,000 funding units in one swap. Before confirming, the user sees and must
  acknowledge Relay's terms: the deposit can wait up to 7 days for a fill, and a
  refund is not guaranteed in amount. Swaps and refunds go only to the user's own
  wallets linked to their Privy account.
- **Activity** is saved per device and per app.

## The vault and its guardian

- **Releases** go only to the user's own Solana wallets linked to their Privy
  account, as single SOL or USDC transfers. ANTARA sets no release cap; the user
  may set optional caps with the Limits layer (owner decision 2026-10-13).
- **The guardian** is a Privy server wallet, owned jointly by ANTARA's server key
  and an offline admin key, under a deny-by-default policy that is designed to
  allow only Squads votes (not yet verified live). It cannot start or execute a
  transfer or change the vault.
- **If ANTARA is offline**, releases pause; funds stay in the vault on-chain.
- **No recovery owner.** If the user loses their ANTARA login, vault funds cannot
  be released. If the guardian stopped working for good, the same would be true.

## The six layers

| Layer | What it is | Kind | Status in code |
|---|---|---|---|
| Biometrics | A passkey (Windows Hello, Touch ID, Face ID, phone, security key) that signs the exact release | Cryptographic | Required to finish activation and for every release |
| MFA | ANTARA's own vault authenticator (RFC 6238 TOTP; works with Google Authenticator) | Cryptographic | Optional and vault-only. While on, ANTARA's server checks a single-use 6-digit code bound to each release; the secret is sealed with AES-256-GCM under `ANTARA_VAULT_TOTP_KEY`. Turning it off is a loosening (immediate, needs every enabled layer); a lost app is a 7-day recovery. The regular wallet never asks for it |
| Safe Zones | Device location inside a safe zone | Device-reported | Optional |
| Wi-Fi | Trusted network (public IP seen by the server); on Desktop also the Wi-Fi name and access point | Server-observed (+ device-reported on Desktop) | Optional |
| Bluetooth | A trusted Bluetooth device present (connected on Desktop, chosen from nearby in Chrome) | Device-reported | Optional |
| Limits | Caps the user sets: per release and/or per day, per asset, any positive amount | Cryptographic (guardian-enforced) | Optional, off by default; no cap applies until the user sets one |

Change rules (owner decision 2026-10-13): every change applies immediately.
Turning a layer on or tightening it needs the session and the passkey; turning
one off, loosening it, or adding an item (place, network, device, passkey) to a
layer that is on needs every currently enabled layer. A layer the user can no
longer satisfy can be skipped through the separate 7-day lost-device recovery
change, which is cancelable. ANTARA sends no notifications about a pending
recovery; the vault shows a warning.

What layers cannot do: they do not protect the regular wallet; they are checked
by ANTARA's server, which could skip them if compromised; device-reported
signals can be faked by a modified or infected device, and on the extension and
web a default or spoofed browser location cannot be refused; no layer measures
distance; and someone holding the user's session (and passing any other enabled
layers) can add a passkey through a 7-day recovery, which is cancelable and shown
on the vault but sends no notification.

Creating the vault, in the order the app enforces it: open **Vault** and choose
**Create vault** (the screen shows the SOL it needs, read live from Solana, and
offers Receive when the wallet holds too little), use the ANTARA Solana wallet,
accept that a lost login means vault funds cannot be released, create (one
signed transaction), let ANTARA verify and register the vault, add the first
passkey in the same app within 15 minutes, deposit, then trust this device
before adding device-read layers or the optional vault authenticator.

## Status (October 13, 2026)

- **Built, with automated tests:** the wallet on five networks in all three apps,
  Relay swaps, the Solana vault and the six layers. Owner decision 2026-10-13
  removed every ANTARA-set amount cap and every 24-hour change or link-age
  delay; Limits is now an optional layer with caps the user sets.
- **Not live:** ANTARA's guardian is not switched on for antara.tech, so no vault
  can be created there yet. A guardian is provisioned in the development Privy
  app (2026-10-13) and paired vaults are enabled only on a local development
  server. Go-live still needs production provisioning, a conclusive live Privy
  policy check (two raw-sign checks were inconclusive) and the check that
  ANTARA's server cannot sign as the user's wallet.
- **Not done:** a real sign-in in any app, funded acceptance, hands-on hardware
  acceptance of the layers, and any security audit.
- **Planned:** EVM vault (Safe 2-of-2), gas sponsorship, swaps from any token,
  website (dApp) connections once the wallet provider confirms its terms allow
  it, a Chrome Web Store listing and a signed Windows installer.

Never describe ANTARA as audited, unhackable, gas-free or quantum-resistant, and
never claim funded acceptance until it is recorded in
[VERIFICATION.md](VERIFICATION.md).
