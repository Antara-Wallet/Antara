# ANTARA security architecture

ANTARA separates convenient account access from reserve custody. The desktop application uses Privy for authentication and a Solana embedded wallet plus an EVM embedded wallet. Each is a single signing owner. Reserve assets live at a Squads v4 vault PDA on Solana or a separate Safe contract on an explicitly selected EVM network.

Supported networks for the primary ANTARA wallet, in display order: Solana (primary/default), Ethereum, BSC (BNB Smart Chain, 56), Robinhood Chain (4663) and Base (8453). On October 12, 2026 the owner removed Arbitrum and Polygon from active support; in the primary wallet and `/api/solares` only read-only legacy metadata remains so saved records can render, never as a selectable network. Network constants live in `src/solares/networks.ts`. The switch is not complete everywhere: the public landing's Networks chapter still shows the earlier set, and the legacy ARK app at `/legacy` covers only Ethereum and Base. See the "Not yet done" list in [HANDOFF.md](HANDOFF.md).

This is an implementation with automated checks, not a security audit or a claim that assets cannot be lost. Credentials, RPC access, funded deployment wallets, and independent owners are required for a live acceptance test. No mainnet funds were used to validate this integration.

## What is implemented

| Boundary | Enforced behavior |
| --- | --- |
| Missing Privy configuration | Disconnected interface remains usable; the Privy SDK is lazy loaded only with an app ID. No synthetic wallet, approval, deposit, or verified-vault state is created. |
| Account identity | The API verifies the Privy Bearer token using the app's configured verification context, then fetches linked wallet accounts for the verified user ID. Caller-supplied wallet addresses must match these accounts. |
| Spending wallets | Native and pinned funding-stablecoin balances are fetched per supported network (see [Funding stablecoins](#funding-stablecoins)). Partial RPC failures are shown as unavailable data, not invented zero balances. |
| Solana reserve | Independent-owner vaults (Settings): Squads v4, at least two distinct owners with initiate, vote, and execute permissions, threshold at least two, autonomous configuration authority. Any on-chain time lock is accepted, including none, and new vaults default to no time lock (owner decision 2026-10-13). |
| Paired Solana vault | Squads v4 with exactly two members: your Privy embedded wallet (initiate, vote, execute) and the ANTARA guardian (vote only). Threshold 2, no configuration authority, no spending limits. The guardian address is pinned in the client build and on the server, and any other guardian is refused. The guardian votes only after the server policy accepts the release; see [Paired vaults](#paired-vaults-october-2026). |
| EVM reserve | Canonical Safe proxy and published implementation/factory bytecode, recognized contract version, at least two owners and threshold at least two, no enabled modules or guard, and a zero or verified compatibility fallback handler. |
| Deposits | The actual deployed vault is verified before constructing a direct native-token or pinned stablecoin transfer. |
| Solana release | A stored vault transaction and corresponding proposal are created, with the initiating owner's first on-chain vote. Every subsequent action re-reads the canonical instruction, votes, stale status, threshold, and delay. |
| EVM release | A portable JSON proposal is bound to the chain, Safe, current nonce, recipient, amount, and calldata through its Safe transaction hash. Independent owners record `approveHash` transactions on-chain. Execution uses those on-chain approvals. |
| Withdrawal scope | Direct native-token and pinned stablecoin transfers only. Delegatecall, self-configuration calls, arbitrary token calls, hidden gas refunds, and unsupported payload shapes are rejected. |
| Success reporting | Solana confirmations must have no on-chain error. Safe execution requires a matching `ExecutionSuccess` event, not merely a successful outer transaction receipt. Known broadcast hashes remain visible if receipt lookup or subsequent verification fails. |
| Action identity | Wallet signers reject stale authenticated sessions, selected owners, or chains at signing time. EVM providers recheck account and network before each signing request, including a second step after approval. |
| Reviewed custody policy | Deposits, proposals, approvals, and execution reject changes to the reviewed owner set, threshold, delay, vault/deposit address, network, or Safe version. This is a preflight check, not an atomic lock on blockchain ordering. |
| Payment identity | EVM sends validate the exact reviewed payload and pending nonce again before dispatch. Confirmation requires the original transaction hash and network; a cancellation or same-nonce replacement is never credited as the original payment. |
| Balance availability | Each chain has a nine-second total RPC budget. Healthy networks survive another network's failure. The wallet validates canonical assets, integer amounts, decimals, duplicate entries, explicit failed chains, and current session identity before display. |
| Native browser isolation | All 29 native app commands are enrolled in Tauri's command ACL. Only the local `main` app webview receives native permissions; browser child webviews have none, including if they reach a local origin. |
| Route recovery | The reviewed route must be saved before any signature. Pending and failed routes are retained beyond the completed-history limit; corrupt recovery data is never overwritten with an empty ledger. |

The new UI is at `src/solares`; wallet adapters are in `wallet`, custody operations in `vaults`, and cross-chain trading in `relay`. Authenticated balance reads are in `server/src/solares/wallet.ts`.

## Independent owners and recovery

Recommended personal reserve configuration: Privy wallet + separately controlled hardware wallet + an independent recovery guardian, with a 2-of-3 threshold. The owner addresses are checked for uniqueness. **Address uniqueness cannot establish independent custody.** The user must keep the keys, device access, cloud recovery accounts, and custodians genuinely separate. Creating three embedded wallets under the same compromised identity does not provide the intended isolation.

Privy authentication recovery recovers access to one owner. It does not override the Squads or Safe threshold. Losing access to enough independent owners can permanently prevent withdrawals. A recovery guardian can approve transactions like any other owner; select and instruct that guardian accordingly.

No guardian private keys are generated, stored, or exported by ANTARA. The ephemeral Solana creation key is used only to create the multisig PDA; it is not a vault owner. Saved vault references in local storage contain only public addresses and the selected network, namespaced to the Privy user. They are not proof of security: the application always verifies the chain state again.

## Privy protection and configuration

Privy's current documented architecture combines trusted execution environments with distributed Shamir key shares. Its internal shares are not the same as independent on-chain vault owners. See [Privy's wallet architecture](https://docs.privy.io/security/wallet-infrastructure/architecture).

1. Create separate development and production Privy apps. Configure permitted web origins for the exact ANTARA runtime: `http://localhost:1420` in development and `https://tauri.localhost` for packaged Windows. Enable email and external-wallet login for EVM and Solana in both desktop and browser; SMS is not used and social login is deferred. Use authenticator/TOTP for wallet MFA.
2. Enable both Solana and Ethereum embedded wallets. ANTARA requests creation for all users who use the login modal. It does not import legacy seed phrases automatically.
3. Set `VITE_PRIVY_APP_ID` in the frontend environment. This is a public app identifier, not the app secret.
4. Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` on the API server. Never use a `VITE_` prefix for a secret. The server app ID must match the frontend app ID. Missing server credentials cause authenticated endpoints to fail closed with a configuration error.
5. Enroll wallet MFA through the application's Privy MFA action. Prefer passkeys, with an independently protected TOTP fallback if needed. Set the wallet MFA verification duration deliberately in the Privy dashboard. Enrollment and enforcement are Privy state; a local UI preference is not equivalent to enabled MFA.
6. Keep the usual Privy signing dialogs enabled. The integration explicitly requests the wallet confirmation UI and never enables unrestricted delegated/session signing.
7. Wallet export (owner decision 2026-10-13). The settings cog on each ANTARA (embedded) wallet can open Privy's `useExportWallet` window, only after an ANTARA warning step the user acknowledges. The key is shown only inside Privy's iframe on `https://auth.privy.io` (already the only Privy `frame-src` in the web, desktop and extension CSPs); ANTARA code never receives, logs, stores or copies it, and failures are reported as fixed messages, never raw errors. Exporting the paired vault's owner key does not change the Squads threshold (releases still need the guardian's vote and the vault's layers), but whoever holds the exported key fully controls the spending wallet. External wallets are exported from their own app.
   - **EVM export can also hand over the Solana wallet.** For a non-imported Ethereum wallet, Privy's export window (react-auth 3.48, `EmbeddedWalletKeyExportScreen`) also offers a recovery phrase. For Privy's legacy wallets (`recoveryMethod` other than `privy-v2`) the embedded Solana wallet is derived from the primary Ethereum wallet's entropy (`get-entropy-details-for-user`), so that phrase also restores the ANTARA Solana wallet, which is the vault's owner key (U). This was not verified either way for `privy-v2` wallets, and the owner's wallets' `recoveryMethod` has not been checked. The EVM warning step therefore says the phrase can restore the ANTARA Solana wallet and to treat it as exporting both; when the selected ANTARA Solana wallet has a vault, both the EVM and Solana steps state that releases still need the guardian and the layers. Every step also says to clear the clipboard afterwards (Privy's iframe may copy with `clipboard-write`; Windows clipboard history and sync can keep it).
   - **Which wallets count as "ANTARA wallet".** Only addresses Privy's linked accounts list as `type: wallet`, an embedded client type and `connectorType: embedded` (the facts the API server checks). What a connected wallet reports about itself (`isPrivyWallet`, an EIP-6963 name that becomes client type `privy`) is never trusted, so another extension cannot get the label, the Export button, the Vault row or the default EVM selection.
   - **Session check.** Export first takes the token through the same subject check as every API call (`wallet/linkRecovery.ts`): if another tab or window signed in a different account, export stops with "Your session changed…" and never opens Privy's window with the other account's token.

[Privy provider setup](https://docs.privy.io/basics/react/setup), [dual-chain creation](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation), [wallet MFA](https://docs.privy.io/authentication/user-authentication/mfa/overview), [access-token verification](https://docs.privy.io/authentication/user-authentication/access-tokens).

Optional Privy authorization quorums and key-level policies can add protection to a spending wallet, but have not been provisioned by this repository. They must not be described as active just because the SDK is installed. Privy policies default to deny where configured, and evaluate each Solana instruction. Stateful cumulative limits are documented for supported Ethereum methods; do not assume they supply equivalent rolling Solana limits. [Privy policy semantics](https://docs.privy.io/controls/policies/overview), [user/server dual authorization](https://docs.privy.io/controls/authorization-keys/owners/configuration/user/dual-approval).

## RPC and network configuration

| Environment variable | Location | Purpose |
| --- | --- | --- |
| `VITE_API_BASE` | Frontend | Optional absolute API origin for desktop or separate hosting. The default is same-origin `/api`, with Vite forwarding local development API requests. |
| `VITE_SOLANA_CLUSTER` | Frontend | `mainnet-beta` by default, or `devnet`. |
| `VITE_SOLANA_RPC_URL` | Frontend | Solana HTTP RPC used to build, verify, and confirm vault actions. It must accept browser requests: `https://api.mainnet-beta.solana.com` answers HTTP 403 to any request with an `Origin` header, and `npm run doctor` and the extension build reject it. Public fallback `https://solana-rpc.publicnode.com`; production should use a domain-restricted provider endpoint. |
| `VITE_SOLANA_WS_URL` | Frontend | Solana WebSocket endpoint required by Privy's Solana RPC configuration. Defaults to the HTTP URL with a WebSocket scheme. |
| `SOLANA_CLUSTER` | API server | Must match the frontend cluster. |
| `SOLANA_RPC_URL` | API server | Server-side Solana balance RPC. |
| `ETHEREUM_RPC_URL` | API server | Ethereum native and USDC balance reads. |
| `BSC_RPC_URL` | API server | BNB Smart Chain native (BNB) and Binance-Peg USDC balance reads. |
| `ROBINHOOD_RPC_URL` | API server | Robinhood Chain native (ETH) and USDG balance reads. |
| `BASE_RPC_URL` | API server | Base native and USDC balance reads. |
| `VITE_ETHEREUM_RPC_URL`, `VITE_BSC_RPC_URL`, `VITE_ROBINHOOD_RPC_URL`, `VITE_BASE_RPC_URL` | Frontend | Optional public EVM RPC overrides. They are compiled into the client bundle and must never contain a secret. |

`ARBITRUM_RPC_URL` and `POLYGON_RPC_URL` are no longer used. The registry's `rpcUrlFor` returns the configured override, or otherwise the pinned keyless public endpoint: Solana `https://api.mainnet-beta.solana.com` on the server and `https://solana-rpc.publicnode.com` in the browser (the official endpoint refuses requests that carry an `Origin` header, which every browser, the desktop webview and the extension send), then `https://ethereum-rpc.publicnode.com`, `https://bsc-dataseed.bnbchain.org`, `https://rpc.mainnet.chain.robinhood.com` and `https://mainnet.base.org` for both. These are rate-limited. A malformed override is rejected rather than silently replaced, and the error names the variable without echoing its value.

### Funding stablecoins

Swaps are funded from the source network's pinned stablecoin, and the first release swaps only from that token. A token is identified by its pinned address and decimals, never by its ticker.

| Network | Token | Address or mint | Decimals | Issuer |
| --- | --- | --- | --- | --- |
| Solana | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | Circle |
| Ethereum | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | Circle |
| BSC | USDC (Binance-Peg) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | Binance (bridged; not Circle) |
| Robinhood Chain | USDG (Paxos Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | Paxos |
| Base | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | Circle |

Binance-Peg USDC uses 18 decimals, unlike Circle USDC; amounts must use the network's decimals and its label must not imply Circle issuance where precision or issuer matters. Robinhood Chain has **no Circle USDC**. USDG is not USDC and is never labelled USDC. An unverified bridged token on Robinhood Chain that names itself USDC (`0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8`) is rejected as a funding token. Relay's separate "Robinhood Lighter" venue (chain id 548123634) is not Robinhood Chain and is never used.

Use HTTPS in production. An RPC key placed in a `VITE_` variable is visible to clients and must be constrained at the RPC provider. EVM vault reads use the connected wallet's provider on the explicitly checked chain. A malicious RPC or compromised browser remains a trust assumption; for high-value operations independently compare the transaction and vault state on a trusted device/explorer.

Solana devnet supports SOL testing; the application does not substitute a fake USDC mint. Relay trading is mainnet only. Use mainnet configuration for an actual cross-chain flow. Solana cluster mismatches between client and API produce an explicit error. Solana RPC genesis hashes are checked against the selected cluster before vault verification and signing; server balance reads check Solana genesis and each EVM chain ID.

## Solana vault details

The pinned Squads v4 program ID is `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. Creation reads the cluster's program configuration and treasury and uses `multisigCreateV2`. `configAuthority` is null; no single application administrator can replace owners or lower the threshold. Every owner receives initiate, vote, and execute permissions. Vault index zero is used for deposits and direct releases.

Attachment requires the actual account to be owned by the Squads program and match its derived multisig PDA. This conservative version rejects vaults with delegated spending-limit accounts, because those permit spending outside the per-transaction quorum. The RPC must support filtered `getProgramAccounts`; if it cannot verify this condition, attachment fails instead of assuming no delegation.

Proposal indices remain exact integers. Released SOL comes from the verified vault PDA. USDC uses the canonical mint and the vault's associated token account. The recipient must also use its canonical associated token account without delegates or custom close authority. Merely reading an arbitrary token account's current owner does not safely bind the recipient: an attacker-controlled account can be closed and recreated at the same address. Proposal review rejects extra instructions, address lookup tables, unexpected ephemeral signers, token source substitution, and unsupported programs. Configuration changes can invalidate pending proposals; stale transactions are rejected.

The SDK and on-chain program enforce quorum and the time delay. The browser's time check is a convenience only. A malicious signer cannot remove the program delay by changing the local clock. Vault configuration and approvals can also be managed through compatible Squads tooling if ANTARA is unavailable.

[Squads SDK](https://docs.squads.so/main/development/typescript/overview), [autonomous configuration and timelock](https://docs.squads.so/main/development/reference/accounts), [creation](https://docs.squads.so/main/development/typescript/instructions/create-multisig), [configuration changes](https://docs.squads.so/main/development/typescript/instructions/create-config-transaction).

## EVM vault details

New vaults use Safe 1.4.1 with no modules, no guard, and a zero fallback handler. Attachment supports recognized 1.3.0, 1.4.1, and 1.5.0 deployments after bytecode and configuration verification. The proxy's storage slot zero is checked against the release deployment registry. The implementation and factory runtime hashes are compared with published hashes; a read-only constructor simulation establishes canonical proxy runtime. A lookalike contract returning convenient owner and threshold values is therefore insufficient to pass these checks.

**Safe core has no mandatory timelock in this configuration.** The UI explicitly shows that EVM releases require quorum but have no delay. ANTARA does not install an unreviewed custom guard/module to imply otherwise. Existing Safes with such extensions are rejected for separate review, rather than represented as fully verified.

Safe transaction proposal JSON contains public transaction data only. Each owner should review the canonical amount, recipient, chain, vault address, and nonce in ANTARA before approving. On-chain approval hashes are domain-separated to the Safe and chain. A proposal edited after approval produces a different hash. The current implementation supports native token and pinned stablecoin transfers, not arbitrary contract execution or EIP-1271 owner-signature collection.

Canonical Safe 1.3.0 and 1.4.1 deployments were observed on BSC (56) and Robinhood Chain (4663) on October 12, 2026 (Safe `0x41675C099F32341bf84BFc5382aF534df5C7461a`, SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, proxy factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, compatibility fallback handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`). When first observed that day, the root `@safe-global/safe-deployments` 1.37.63 listed chain 4663 but the API server's 1.37.56 did not. That is resolved: `server/package.json` now pins 1.37.63 as well, and its installed copy lists 4663 as canonical for Safe 1.4.1. No Safe lifecycle has been accepted on either chain.

[Safe security model](https://docs.safe.global/advanced/smart-account-overview), [deployment](https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment), [multichain deployment](https://docs.safe.global/sdk/protocol-kit/guides/multichain-safe-deployment), [transaction signatures](https://docs.safe.global/sdk/protocol-kit/guides/execute-transactions), [release registry](https://github.com/safe-global/safe-deployments).

## Spending and Relay

The aggregate stablecoin view is a view of balances on distinct chains, in different tokens and decimals. It does not represent a single synchronized bank balance or promise atomic withdrawals from all reserves. A Relay route spends from the selected spending wallet and delivers the selected output to the destination wallet. It does not receive a vault signing key or permission to bypass vault approval.

For trading, first release a bounded amount from the reserve, wait for confirmation, then request a fresh route quote. Multisig approval delays make pre-quoted swaps stale. Quote validation, simulation, exact token/address display, slippage bounds, and explicit wallet approval remain necessary. A cross-chain route additionally introduces route-provider, solver, chain-finality, token, and smart-contract risks.

Both the API and wallet verify the settlement order hash. The wallet also binds the reviewed request ID and expiry to the order. Status updates cannot request another signature, erase a known delivery/refund, or mark delivery without a corresponding settlement transaction hash. Relay's reported settlement is not an independent destination-chain finality proof. A failed fill is not proof of a refund. Recovery records remain device-local; local storage is not a backed-up server queue.

## Native browser boundary

App commands, including legacy signing and key-reveal commands, have explicit generated permissions granted only to the local `main` webview. A window-wide capability would also cover child webviews and is deliberately absent. Rust tests inspect the generated command registry and evaluate Tauri's runtime ACL for local/remote origins and main/child webviews. See [Tauri capabilities](https://tauri.app/security/capabilities/).

Embedded browser initial loads and subsequent navigation accept HTTP(S) public hostnames only. Local schemes, credential-bearing URLs, IP literals, internal hostnames, and unmanaged popup windows are rejected. This limits navigation; it is **not a DNS-rebinding or subresource firewall**. WebView2/network-level controls are still responsible for those boundaries. No third-party page receives native IPC permission.

## Legacy layers and migration

The original Rust/Tauri encrypted-key vault, USB detection, Bluetooth presence, location policies, WebAuthn, Safe policy engine, stealth-address tools, and co-signer source are retained. They are not silently declared active on new Privy accounts. New browser flows use the separately authenticated `/api/solares` endpoints. Legacy mutation APIs are disabled by default and require an explicit operator enablement for legacy compatibility.

The current opt-in variable is `ANTARA_ENABLE_LEGACY_API`; an explicitly configured value takes precedence over the older `AETHRA_ENABLE_LEGACY_API` and `SOLARES_ENABLE_LEGACY_API` aliases. Keep it `false` for the Privy deployment. The legacy credential-reset endpoint uses the server-only `ANTARA_ADMIN_SECRET`, with `AETHRA_ADMIN_SECRET`, `SOLARES_ADMIN_SECRET`, and `ARK_ADMIN_SECRET` accepted for compatibility. These variables do not activate device/location rules or provision a co-signer for a new Privy vault.

USB enumeration, Bluetooth identifiers, GPS coordinates, and voice scores sent by a client are **untrusted contextual signals**. Their presence alone is not cryptographic proof of a physical device, proximity, identity, or location. WebAuthn verification on the server can establish possession of a registered credential when the challenge, origin, relying party, and intended operation are correctly bound. On ANTARA Desktop it does not establish which program asked: Windows' `webauthn.dll` accepts any relying-party ID and client data from any local process, so another local program can show the same Windows Hello prompt for `antara.tech` over a challenge it obtained with a stolen session. A desktop passkey approval binds the user's verification to the exact challenge, and the `https://tauri.localhost` origin (shared by every Tauri app) does not identify ANTARA (docs/VAULT_LAYERS.md §3). Privy wallet MFA and independent on-chain owner approval provide the new cryptographic boundaries.

The new flow does not automatically call the legacy backend co-signer or replace independent owners with it. Existing policy vaults must continue through their compatible legacy route or be migrated by their current on-chain owners. Never weaken a vault threshold or export seed material as an automatic migration shortcut.

## Validation and release criteria

Automated tests cover threshold/owner invariants, exact monetary parsing, hostile Safe proposal fields, mutable Solana recipient accounts, cross-chain address ownership checks, wrong RPC networks, missing-authentication configuration, and signing requests after a session/account/chain changes. Frontend and backend TypeScript compilation validate SDK integration surfaces. These are valuable regression checks, not a replacement for a deployment acceptance test.

Before accepting production deposits, complete the real Privy login/MFA flow, create a small Solana test vault, confirm that one owner cannot execute, approve with a separate owner, verify any configured time lock, deposit/withdraw a small supported amount, and repeat the Safe quorum lifecycle on the intended chain. Verify recovery with independent tooling. Audit the deployed browser/API configuration and conduct independent review before holding substantial value.

## Paired vaults (October 2026)

The Vault tab pairs each wallet with its own vault. On **Solana** this is a 2-of-2 Squads vault co-signed by the ANTARA guardian. On the **EVM networks** it is still read-only discovery of an existing ARK Safe; the EVM paired vault comes next. Design, policy, provisioning and limits are in [GUARDIAN.md](GUARDIAN.md).

### Solana paired vault

| Item | Behavior |
| --- | --- |
| Members | U = your Privy embedded Solana wallet (initiate, vote, execute). G = the ANTARA guardian, a Privy server wallet with **vote only**. Threshold 2, time lock 0, no configuration authority, no spending limits, a random `createKey`, rent back to U, memo `ANTARA paired vault v1`. |
| Guardian pin | `VITE_ANTARA_GUARDIAN_SOLANA` in the client build and `ANTARA_GUARDIAN_SOLANA_ADDRESS` on the server. The client refuses to create, verify or use a vault with any other guardian. A build without a pin shows paired vaults as unavailable. |
| Routes | `GET /api/solares/paired-vault/solana/config`, `GET /solana/account`, `GET /solana/vaults`, `POST /solana/register`, `POST /solana/approve` and `GET /limits?multisig=` (the vault's optional user-set caps), plus the layer routes. Every route requires a verified Privy session, and register and approve are also rate limited per account. Until the owner switch `ANTARA_PAIRED_VAULTS_ENABLED` is exactly `true` (set only after both go-live gates are recorded), and whenever the guardian is not configured, they answer `503` with code `not-provisioned`, and nothing is created, shown or approved. |
| Registration | The server re-reads the vault on-chain. It accepts only members exactly {U:7, G:2}, threshold 2, time lock 0 and no configuration authority. U must be the caller's own linked, non-delegated Privy embedded wallet, and an authenticator app (TOTP) must be enrolled. |
| Release | U proposes and approves one SOL or Circle USDC transfer in one transaction. The server decodes the stored transaction with the same decoder as the client. It votes only for a release to one of your own Privy-linked wallets and, when the vault's optional Limits layer is on, within the caps you set. ANTARA sets no cap of its own and no link-age wait (owner decision 2026-10-13). Only U can execute. ANTARA never approves the same release twice: a repeat is answered from the chain (`already-approved`) or the ledger (`pending`, for 90 seconds); after that window a retry may send a fresh vote transaction for the same reservation, which Squads records at most once. The client offers only recipients that the server lists **and** the device itself sees as your wallets, defaults to your own wallet, and shows the full address before you sign. |
| Protection layers | Implemented and tested, **not live** ([VAULT_LAYERS.md](VAULT_LAYERS.md)). Before the guardian votes, every release must pass the vault's layers for that exact release: a passkey (required for every vault and every release, server-verified, user verification required), a code from the vault authenticator when MFA is on, your own caps when Limits is on, and, when enrolled, a signed location inside a safe zone, the server-observed public IP inside a trusted network (plus the Wi-Fi name and access point on Desktop in `network+radio` mode) and an enrolled Bluetooth device for this app. Readings are signed by a per-vault, per-app device key (software, non-extractable) and bound to a single-use, 5-minute challenge over the on-chain transaction bytes and the decoded intent. Every layer fails closed. Every change applies immediately; turning a layer off, loosening it, or adding an item to a layer that is on needs every enabled layer. Recovery without a layer you can no longer satisfy waits 7 days. |
| Storage | Registrations and the approval ledger live on a Render persistent disk (`DATA_DIR`). The server opens the store at start-up and logs `initialised`, `ready` or `refused`. If storage is unreadable, missing after initialisation, or (in production) never initialised, every release is denied. |

What is honest to claim:

- Vault releases need two signatures: your wallet and ANTARA's guardian.
- On Solana the guardian can only vote. It cannot start or execute a transfer.
- ANTARA co-signs only single SOL or USDC releases to your own wallets linked to your account, within any caps you set.
- **If ANTARA is unavailable, releases pause.** Vault funds cannot move until the guardian votes again.
- **If you lose access to your ANTARA login, vault funds cannot be released.** U is your Privy wallet and the guardian can only vote, so this version has no recovery owner.
- Both keys are held by Privy: your wallet as a Privy embedded wallet, and the guardian as an ANTARA server wallet.
- Spending-wallet funds are not protected by the vault.

Do not claim:

- That the vault protects you against a compromised ANTARA server, until `scripts/provision-guardian.mjs --probe-user-jwt` has passed on each Privy app (see the trust model below).
- Per-transaction MFA. Privy caches a successful MFA check for about 15 minutes; ANTARA checks that TOTP is **enrolled**.
- Geofence, device or biometric enforcement as live: the protection layers are implemented but not switched on. Once live, use only the wording in [VAULT_LAYERS.md](VAULT_LAYERS.md) §14, and only while `GET /solana/layers` answers 200 and the layer is enrolled.
- That device-reported layers (Safe Zones, Bluetooth, the Wi-Fi name) prove where a device is or what is near it: a modified device or location spoofing can fake them. Bluetooth never measures distance. On the extension and web a spoofed or default browser location cannot be detected.
- That a passkey or an extension origin identifies ANTARA's code: any local program can request an `antara.tech` assertion from `webauthn.dll`, and a sideloaded extension can copy the public extension key and its origin.
- That a stolen session cannot weaken the layers: it can schedule a recovery passkey that takes effect after 7 days unless you cancel it, and can then use it to remove your original passkey. ANTARA sends no notifications; the vault card shows the pending change.
- Voice or USB checks (not offered).
- "Cannot be hacked" or "gas-free".
- Any amount protection if your own Privy wallet and TOTP are compromised and you set no caps (Limits is optional; ANTARA sets no cap).
- That the guardian key can sign only Squads votes under a Privy policy, until `scripts/provision-guardian.mjs --verify-policy` has passed against the deployed guardian.

As of this update the guardian has not been provisioned, neither go-live gate (`--verify-policy`, `--probe-user-jwt`) has run, the protection layers have not been checked on real hardware (passkeys, location, Wi-Fi and Bluetooth on the owner's devices), and **funded acceptance has not been completed**. Automated tests, including the headless end-to-end layer test, are not funded or hardware acceptance.

**Trust model.** Both U and G are custodied by Privy, and the API server receives each signed-in user's Privy access token. The 2-of-2 holds against a compromised ANTARA server only if that server cannot exchange the token to sign as U; this is **not yet verified** (see the trust model in [GUARDIAN.md](GUARDIAN.md#trust-model-and-what-a-compromised-server-can-do)). If it cannot, a compromised server can still skip its own checks and vote with G on any proposal your wallet has already created and approved, but it cannot initiate or execute a vault transaction, and it cannot change the guardian's Privy policy without the owner's offline admin key. It also cannot steer a release to its own address through the packaged desktop app or the extension: they offer, propose and execute only to recipients the device itself sees as your wallets. The web app is served by the same server, so on the web that device-side check is not an independent control. Delegated (server) signing on U is refused at registration and on every release.

### EVM networks

The interface keeps authenticated **read-only discovery** at `GET /api/solares/paired-vault`.

- It derives the original ARK Safe configuration (2-of-2: the wallet and the legacy policy co-signer) only for a wallet freshly verified as linked to the Privy user.
- The frontend checks deployed results independently on-chain, including the exact wallet/co-signer owner pair, the threshold and a supported Safe implementation.
- Results are scoped to the selected account, wallet and network, so an obsolete read cannot update a newly selected wallet.
- Undeployed predicted addresses are never shown as deposit destinations.
- The original implementation is in `src/screens/Dashboard.tsx` (history `38e0548` and `b3ad328`).

EVM paired-vault creation, policy changes and transfers remain disabled. The legacy signing and policy endpoints are disabled by default, and enabling the old API is **not** a Privy integration. Treat the legacy `COSIGNER_PRIVATE_KEY` as exposed. Existing device and location reports are client-reported signals, not independent cryptographic proofs.

Independently managed Safe and Squads funds stay accessible through Settings → Existing multisig vaults, with their existing on-chain verification and quorum requirements. A paired Solana vault cannot be opened there: its vote-only guardian fails the stricter independent-owner rules (every owner needs initiate, vote and execute), which are never relaxed for it. Saved references and proposal data are kept, and they are never silently reclassified as paired vaults.
