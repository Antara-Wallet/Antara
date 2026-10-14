# ANTARA paired-vault guardian (Solana)

Status on 2026-10-12, updated 2026-10-13 for the vault protection layers:

- **No Privy MFA (owner decision 2026-10-13): implemented, with automated tests, not live.** The regular wallet has no MFA, and the guardian no longer reads Privy `mfa_methods`: registration, activation, releases, layer changes and cancels need no Privy TOTP (`PrivyUserFacts` has no `totpEnrolled`). MFA is now ANTARA's own optional vault authenticator, one of the protection layers (RFC 6238, sealed at rest under `ANTARA_VAULT_TOTP_KEY`; [VAULT_LAYERS.md](VAULT_LAYERS.md), note at the top). `GET /solana/account` keeps `mfaEnrolled` for wire compatibility and always answers `true`; the client ignores it (remove it together with the `pairedApi.ts` parser and the `mfa` branch of `vaults/summary.ts` in a later cleanup). Statements below about TOTP checks are superseded by this line.
- **Protection layers (2026-10-13): implemented, with automated tests, not live.** Every release now also needs the vault's protection layers (Biometrics passkey, MFA, Limits, and Safe Zones, Wi-Fi and Bluetooth when enrolled) to pass for that exact release before the guardian votes. The contract, the honest claims and the open owner decisions D1 to D4 are in [VAULT_LAYERS.md](VAULT_LAYERS.md); the evidence, including a headless end-to-end run of the client flow code against the real routes, is in [VERIFICATION.md](VERIFICATION.md). The §15 hardware checks and funded acceptance are not done.
- **Implemented, with automated tests:**
  - the shared decoder, the server policy, the persistent store, and the guardian signer and service
  - the owner's provisioning script
  - the HTTP routes (`server/src/solares/pairedVault.ts`), including the `ANTARA_PAIRED_VAULTS_ENABLED` owner switch
  - the client API parsers and the paired-vault helpers (`pairedApi.ts`, `solana.ts`, `validation.ts`)
- **Implemented; unit-tested parsers and helpers; UI browser coverage pending:** the Vault-tab UI for Solana (`PairedSolanaVault.tsx`). The only browser test that reaches it covers the no-pin state. The activate, TOTP, active and release states have no browser test yet (see [Required shared edits](#required-shared-edits)).
- **Provisioned in the development Privy app only (2026-10-13).** Guardian wallet `H2a8XKroe5rm98r5THsettqSPitwXjsyg3eyFzRUKXHx`, pinned locally as `VITE_ANTARA_GUARDIAN_SOLANA` (`.env.local`, git-ignored) with `ANTARA_PAIRED_VAULTS_ENABLED=true` in the local `server/.env` only. `--verify-policy`: 11 of 13 checks passed; the 2 `rawSign` checks were **inconclusive** (Privy rejected the request format with `invalid_data`, so neither an allow nor a deny was observed). `--probe-user-jwt` has **not** been run. Production (Render, antara.tech) is not provisioned and its switch stays off.
- **Not done yet:**
  - The vault browser tests for the activate, TOTP, active and release states in `tests/browser` (the parity harness in `tests/parity` now covers the pinned-guardian vault screens headlessly). See [Required shared edits](#required-shared-edits).
  - Production Privy provisioning.
  - A conclusive `--verify-policy` (the 2 `rawSign` checks) and `--probe-user-jwt` (see [Go-live gates](#go-live-gates)).
  - Funded acceptance.

Nothing on this page means a vault release has worked with real funds. The 2-of-2 claim is **not yet verified** against a compromised ANTARA server (see [Trust model](#trust-model-and-what-a-compromised-server-can-do)).

## Model

| | Paired vault |
|---|---|
| Contract | Squads v4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, vault index 0 |
| Members | **U**: the user's Privy embedded Solana wallet, with Initiate, Vote and Execute (mask 7). **G**: ANTARA's guardian, **Vote only** (mask 2). |
| Threshold | 2 |
| Config authority | None. The vault is autonomous, so members, threshold and time lock can change only through a configuration transaction. The guardian never approves one. |
| Spending limits | None. A spending limit would let a single member bypass the 2-of-2 rule. |
| Time lock | **Exactly 0** (owner decision). The client and the guardian refuse a paired vault with any other time lock, because neither handles a delayed execution. |
| `createKey` | Random. Never derived from the user's key. |
| Rent collector | None, or U |
| Guardian | One Privy **server wallet** per Privy app environment, shared by all users. Its address is pinned on the server (`ANTARA_GUARDIAN_SOLANA_ADDRESS`) and in the client build (`VITE_ANTARA_GUARDIAN_SOLANA`). |
| Custody | **Both keys are held by Privy**: U as the user's embedded wallet, G as an app server wallet. |

How the guardian key is controlled:

- **Owner:** a key quorum of {ANTARA server P-256 key, owner's **offline admin** P-256 key} with threshold 2. Changing the wallet's owner, its policies or its list of signers, or exporting the key, needs the offline admin key.
- **Day-to-day signer:** an additional 1-of-1 key quorum {server key}, bound to a deny-by-default Privy policy. The same policy is also attached at wallet level.
- **What the server key alone can change:** the *membership* of that 1-of-1 signer quorum. A key quorum is updated by its own members, so whoever holds the server key could add a persistent extra key to it. That key would still be bounded by the override policy. The server re-checks the quorum (see [What the guardian signs](#what-the-guardian-signs)) and stops signing if it changed.
- **Rotating the server key:** create a new 1-of-1 signer quorum with the new key. Then, through the owner quorum (old server key + offline admin key), replace the wallet's additional signer with the new quorum, delete the old signer quorum, and update the owner quorum to {new server key, admin key}. Update `ANTARA_GUARDIAN_AUTH_KEY` and `ANTARA_GUARDIAN_SIGNER_ID`. This procedure is not scripted yet.

## Files

| File | Role |
|---|---|
| `src/solares/paired/solanaDecode.ts` | Pure decoders shared by client and server. They verify the paired multisig, the proposal and the single-transfer vault transaction, check the USDC destination account, and build and verify the guardian transaction. Server code exchanges only strings, `bigint` and `Uint8Array` with this file, because the server has its own copy of `@solana/web3.js`. |
| `src/solares/paired/testFixtures.ts` | Test-only builders that produce real Squads account bytes with the `@sqds/multisig` serializers, plus a hook to forge message headers. Never import it from application code. |
| `server/src/solares/vaultPolicy.ts` | `evaluateRegistration`, `evaluateRelease`, the optional user-set caps, `approvalsInWindow` and `privyUserFacts`. Pure; any error denies. |
| `server/src/solares/vaultStore.ts` | `DATA_DIR/paired-vaults-solana.json`: registrations and the approval ledger, plus the `paired-vaults-solana.initialised` marker. Writes are atomic, it fails closed, and ledger entries are idempotent per (multisig, index). |
| `server/src/solares/guardian.ts` | Guardian configuration, the Privy adapter, the signer (verifies the Privy binding, builds, verifies, then signs and sends), Solana JSON-RPC reads, and the `config`, `register`, `approve`, `limits` and `vaults` service. |
| `server/src/solares/pairedVault.ts` | Routes under `/api/solares/paired-vault`: `GET /solana/config`, `GET /solana/account`, `GET /solana/vaults`, `POST /solana/register`, `POST /solana/approve`, `GET /limits?multisig=` (the vault's user-set caps, if any), plus the read-only EVM ARK discovery at `GET /`. |
| `src/solares/vaults/pairedApi.ts`, `solana.ts`, `validation.ts`, `PairedSolanaVault.tsx` | Client: the build pin and strict response parsers; verify, create (`buildPairedCreateInstruction`), deposit, propose, read, wait and execute; `validatePairedVault`; and the Vault-tab UI for Solana. |
| `server/src/solares/layers/` | Vault protection layers: binding digests and challenges, passkey and trusted-device verification, the policy (`evaluateLayers`, change classes, the 7-day lost-device recovery delay), and the service behind the layer routes and the release authorization ([VAULT_LAYERS.md](VAULT_LAYERS.md)). `testAuthenticator.ts` and `testHarness.ts` are test only. |
| `src/solares/layers/`, `src/platform/{native,layers}.ts`, `src-tauri/src/{layers,layer_passkey*}.rs` | Client collectors, strict parsers, evidence signing and the layer UI; the platform wrappers; the native Windows commands (location, Wi-Fi, connected Bluetooth, passkeys through `webauthn.dll`). |
| `scripts/provision-guardian.mjs` | Owner-run provisioning: `--generate-admin-key`, `--dry-run`, `--write-env` or `--key-out`, `--verify-policy` and `--probe-user-jwt`. Unit tests: `scripts/provision-guardian.test.mjs`. |

## Flows

1. **Activate**
   1. Client: the user is signed in and has TOTP enrolled. The client calls `GET /api/solares/paired-vault/solana/config` and checks that `guardian` equals the build pin. The server answers `configured: true` only when the owner switch `ANTARA_PAIRED_VAULTS_ENABLED` is `true` and after it has proved, with Privy, that G is the pinned, policy-bound guardian wallet and that the store is readable. Otherwise it answers `503`: code `not-provisioned` when the switch is off or the guardian is not configured, or `unavailable`. The client also calls `GET /solana/account` for TOTP enrollment and which linked wallets can be U.
   2. Client: builds `multisigCreateV2` with `pairedMultisigMembers(U, G)`, threshold 2, time lock 0, a random `createKey`, `configAuthority: null`, `rentCollector: U` and memo `ANTARA paired vault v1`. U signs and pays.
   3. Client: verifies the vault with `decodePairedMultisig` (RPC read and spending-limit count), then calls `POST /solana/register {multisig}`.
   4. Server: verifies the guardian binding again, then `evaluateRegistration` requires a verified session, TOTP enrolled, the exact paired configuration with the pinned G, and U being **this user's own Privy embedded wallet that only the user can sign with** (not delegated; `user_can_sign` not false). The server then stores `{privyUserId, user, multisig, guardian, vault, createdAt}`.
   5. **Passkey (owner decision: required).** The vault is not active until a passkey is in force. Registration opens a 15-minute window for the registering Privy session, in which its first passkey applies at once; from anywhere else, or later, the first passkey is a 7-day recovery change. Until a passkey is in force, deposits and releases are paused in the app and the server refuses every release and every other layer change.
2. **Deposit:** SOL or USDC goes to the vault PDA (index 0). The client shows the deposit address only after registration succeeds.
3. **Release**
   1. Client: the recipient list is bound on the device. A wallet is offered only when the server lists it as one of the user's linked wallets **and** this client itself sees it as one of the user's Solana wallets (the ANTARA wallet or a wallet connected in this app). The default is U only. The client shows the full recipient address, asset and amount in a review step before U signs, and `proposePairedSolanaRelease` and `executePairedSolanaRelease` refuse any recipient outside that device-side list. Release and Continue are disabled, with the reason shown, while TOTP is not enrolled or U is no longer a valid paired wallet, because ANTARA would refuse to vote.
   2. U sends, in one transaction: `vaultTransactionCreate` (exactly one transfer), `proposalCreate`, and `proposalApprove(U)`.
   3. The client calls `POST /solana/approve {multisig, transactionIndex}`. A vault with layers answers `403 layers-required`; the client then calls `POST /solana/layers/approval/begin`, checks that the release the server describes matches the proposal it reads on-chain itself, collects the readings and the passkey for that challenge, signs the readings with this device's trusted key, and calls `/solana/approve` again with the evidence ([VAULT_LAYERS.md](VAULT_LAYERS.md) §12). In the extension side panel these steps continue in a full tab.
   4. The server verifies the guardian binding **before** anything is reserved, then reads fresh `confirmed` state: the multisig, proposal, vault transaction, spending limits, and the USDC destination account when relevant.
   5. Under the store lock, the server runs `evaluateRelease` and the layer step (`evaluateLayers` for this exact release; a single-use release authorization on success), applies the anti-abuse vote rate limits, then reserves a ledger entry. The store refuses a reservation without that authorization and re-checks the vault's own caps when the user set any.
   6. The guardian signs and sends **its own** `proposal_approve` through Privy. The signature and its time are recorded.
   7. U executes. Only U has Execute permission.
4. **Retry**
   - If G's vote is already on-chain, the server answers `already-approved` and does not sign again.
   - If G signed less than 90 seconds ago (the blockhash lifetime), the server answers `{status: 'pending', signature}` and does not sign again. The client polls the proposal.
   - After that window, a retry signs a fresh vote. It reuses the reservation, so it is not counted twice against the user's caps or the per-account vote rate limit.

## What the server enforces (every failure denies)

1. **Identity**
   - The Privy access token verifies.
   - The vault is registered to this Privy user and to the current G.
   - U is still a linked wallet of this user, is still the user's Privy embedded wallet, is **not delegated** (Privy `delegated` is `false`; missing or `true` denies), and Privy does not report `user_can_sign: false`. This is re-checked on every release, because delegation can be granted after registration.
2. **MFA:** *(changed 2026-10-13)* no Privy MFA is read or required. When the vault's own authenticator is on, the layer step (item 11) requires a single-use 6-digit code for this exact release.
3. **On-chain state:** read within the last 30 seconds from an RPC whose genesis hash matches the configured cluster.
   - The multisig account is owned by Squads, its PDA derives correctly from `createKey`, and it has no config authority.
   - Threshold is 2, the time lock is 0, and the members are exactly {U:7, G:2}.
   - It has no spending limits, and its rent collector is U or none.
4. **Proposal**
   - The proposal is at its derived PDA and bound to this vault and index.
   - The index is at most the vault's current index and above its stale index (not stale).
   - Status is `Active`, with no rejections or cancellations, and the only approval so far is U's.
   - If G already approved, the server returns the idempotent answer.
5. **Exact payload**
   - The transaction is a `VaultTransaction`. Configuration and batch transactions are **never** approved.
   - Vault index 0, no ephemeral signers, no address lookup tables, exactly one instruction, no repeated account, the vault PDA as the only signer, a valid header, and no extra accounts.
   - The instruction is either a System `Transfer` of SOL from the vault, or an SPL Token (not Token-2022) `TransferChecked` of canonical USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals) from the vault's own ATA to the recipient's **canonical** ATA.
   - For USDC, that ATA must exist, be owned by the recipient, hold USDC, and have no delegate and no close authority. It must not be frozen.
   - **USDC releases are mainnet-only.** The USDC mint is pinned to Circle's mainnet mint, so a devnet paired vault can release SOL only.
6. **Recipient**
   - The recipient must be one of this user's linked Solana wallets, and never G, the vault or the multisig.
   - There is no link-age wait (owner decision 2026-10-13): a wallet counts as soon as Privy lists it as linked to this user. The own-wallet rule is unchanged.
7. **Limits (optional, owner decision 2026-10-13):** ANTARA sets no default cap, no server ceiling and no minimum release. When the vault's Limits layer is on, the guardian refuses a release above the caps the user set (per release and/or per day, per asset, any positive amount), counted in raw units from the ledger; an unreadable ledger denies. When no cap is set, no cap applies. The former `ANTARA_VAULT_*` cap variables are no longer read.
8. **Rate**
   - **Per-account request limits:** 60 requests per minute across the paired-vault routes, and 10 per minute for register and approve. A coarse per-IP limit runs before authentication.
   - **Anti-abuse vote rate limits (kept on purpose):** each guardian vote is paid from G's SOL float, so the number of votes, not their amounts, is bounded. Per account: at most `ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR` (default 120, at most 10,000) new reservations per rolling hour and `ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY` (default 2,000, at most 100,000) per rolling day, counted from the persistent ledger. Owner decision 2026-10-13 raised these defaults (from 6 and 24) far above normal use, so they never block an ordinary release. A retry of an existing reservation is not a new reservation.
   - **Global vote rate limit:** `ANTARA_GUARDIAN_MAX_APPROVALS_PER_HOUR` (default 2,000, at most 100,000; raised from 120 on 2026-10-13) guardian votes per rolling hour across all accounts, in memory. It bounds fee spend from G's SOL float.
   - A malformed rate-limit override disables the guardian (`503`) instead of falling back to a default.
   - Concurrent requests from the **same account** for the same proposal get `409`. The in-flight guard is keyed by account, so another account's request for a (public) multisig and index never blocks the owner; it is refused as "another account". Reservation and signing are serialised across all requests by the store lock and the ledger.
9. **Storage:** the store refuses (`503`) when its document is missing but its marker exists (data loss), and, in production, when neither exists (wrong `DATA_DIR`, or an unmounted or wiped disk). A deliberate fresh install needs `ANTARA_VAULT_STORE_INIT=1` for one start (see [Owner provisioning](#owner-provisioning)). The server opens the store **at start-up**, independent of the guardian settings and the owner switch, and logs one `antara.vault-store` line: `initialised` (this start wrote the marker and an empty store), `ready`, or `refused` with ANTARA's reason (never a path or value). In development only `initialised` and `refused` are logged.
10. **Audit:** one JSON line per decision (`event: antara.guardian`). Each line has the user id, multisig, index, outcome (including `pending`), reason, asset, amount and signature. It never contains a key or token. Layer decisions write `event: antara.guardian.layers` lines with no readings, IPs, SSIDs, BSSIDs, identifiers, keys or assertions.
11. **Protection layers** ([VAULT_LAYERS.md](VAULT_LAYERS.md) §7): a passkey assertion for this exact release (required for every release), plus every enrolled layer: a signed location reading inside a safe zone, the server-observed public IP inside a trusted network (and, in `network+radio` mode, a signed Desktop reading of an enrolled Wi-Fi name and access point), a signed reading that includes an enrolled Bluetooth device for this app, a code from the vault authenticator when MFA is on, and the caps the user set when Limits is on. Device readings must be signed by a trusted device key enrolled for this vault and app. Evidence is bound to a single-use, 5-minute challenge for this user, session, vault and release digest (the on-chain transaction bytes and the decoded intent); a changed proposal or configuration is `challenge-stale`. Five failed checks in 15 minutes lock that vault's layer routes for 15 minutes. Turning a layer off or loosening it needs every enabled layer and applies at once (owner decision 2026-10-13); a recovery that waives a layer waits 7 days. Every failure denies.

## What the guardian signs

- The server builds the only transaction G ever signs: one Squads `proposal_approve` with
  - accounts `[multisig, member = G (signer, writable), proposal PDA]`
  - data = the discriminator `[144,37,164,136,188,216,42,248]` followed by `0x00` (no memo)
  - G as fee payer and only signer
  - a v0 message with no lookup table and no compute-budget instruction
- `assertGuardianApproveTransaction` re-checks these bytes before Privy is called. A builder that returns anything else is refused; tests cover 14 tampered variants.
- Client-built transactions are never accepted.
- **Privy binding check.** `GET /solana/config`, registration and every approval (before anything is reserved) first prove, with Privy, that:
  - the wallet's `id`, `address` and `chain_type: solana` match the pinned values
  - it was never exported, imported or archived
  - `owner_id` equals `ANTARA_GUARDIAN_OWNER_QUORUM_ID`
  - `policy_ids` is exactly `[ANTARA_GUARDIAN_POLICY_ID]`
  - `additional_signers` is exactly one entry, `ANTARA_GUARDIAN_SIGNER_ID`, with `override_policy_ids` exactly `[ANTARA_GUARDIAN_POLICY_ID]`
  - the signer quorum has threshold 1, no users and no nested quorums, and its only key is the public half of `ANTARA_GUARDIAN_AUTH_KEY`
  - the owner quorum has threshold 2, exactly two keys (one of them the server key), no users and no nested quorums

  A success is trusted for 10 minutes and then checked again; a failure is never cached. If the check fails, `config` answers `503` (code `unavailable`), and no vault is registered, shown or co-signed. This stops a mistyped or wrong-app guardian from collecting deposits into vaults that nobody can co-sign.

**Privy policy** (second layer, enforced in Privy's TEE).

- **Default:** deny.
- **Allowed methods:** `signAndSendTransaction` and `signTransaction`, only when **every** instruction is `programId == SQDS4…` **and** matches an IDL `instruction_name == proposal_approve` condition.
- **ComputeBudget is not allowed** by default. Privy cannot cap the compute-unit price, so allowing it would let the server key make G sign ComputeBudget-only transactions, or approvals with a huge priority fee, and drain G's SOL through fees. `--allow-compute-budget` opts in for a future priority-fee design; a guardian provisioned with it fails `--verify-policy` and must not be used for releases.
- **Denied by default:** `signMessage`, `rawSign`, the `transfer` action, export, and everything else. Privy's policy-method list also names `signTransactionBytes` and `signRawMessageBytes`; `@privy-io/node` 0.35.0 has no separate call for them, so the `rawSign` cases are the closest available probe.
- **Evaluation:** according to Privy's policy overview, every instruction in a Solana transaction is evaluated and each must be allowed. This has **not** yet been proven live. Run `--verify-policy`; see [Go-live gates](#go-live-gates).
- **SDK note:** the IDL condition (`field_source: solana_instruction_data`, with the `idl` key holding an Anchor 0.30+ IDL) is not in the `@privy-io/node` 0.35.0 type union. The script sends it through the SDK as documented in Privy's Solana IDL policies page, linked under [Sources](#sources).

## Trust model and what a compromised server can do

- **The 2-of-2 holds only if the ANTARA server cannot sign as U.** That is **not yet verified.**
  - Both U and G are custodied by Privy.
  - The server receives every signed-in user's Privy access token as a Bearer token.
  - `@privy-io/node` supports `authorization_context.user_jwts`, which exchanges a user JWT for a session key "authorized to act on the user's wallets" (`wallets().authenticateWithJwt`). Privy's docs say an app using Privy authentication can skip the JWT-provider setup for this, which suggests Privy access tokens may be accepted.
  - If they are, a compromised server could initiate, vote and execute as U for any user with a live session, which bypasses every cap. Run `--probe-user-jwt` before go-live.
- **Delegated wallets.** If U has delegated (server) signing, the app can sign as U. Registration and every release therefore deny when Privy reports `delegated: true`, does not report it, or reports `user_can_sign: false`.
- **What the Privy policy cannot do:** it cannot tell a vote on a valid user proposal from a vote on any other proposal. A compromised server can therefore vote with G on any proposal that a user's wallet has already created. If (and only if) the server also cannot sign as U, it still cannot initiate or execute a vault transaction, because G has Vote only. It cannot change the guardian's policy, owner or signer list without the offline admin key, though it can edit the membership of the 1-of-1 signer quorum (see [Model](#model)).
- **Steering a release through the client.** The server's account answer lists which linked wallets may receive releases. A compromised server could list its own address there. The client therefore offers a recipient only when it also sees that wallet on the device as one of the user's own Solana wallets, defaults to U, shows the full address before U signs, and refuses to propose or execute a release to any other address. This protects the **packaged desktop app and the Chrome extension**, whose code ships in the build. The **web app** at `https://antara.tech` is served by the same server, so a compromised server could also serve modified client code; there the device-side check is not an independent control.
- **If the probe shows the server can sign as U**, revisit the design before M4. Options to evaluate:
  - a Privy dashboard setting that blocks server-side JWT exchange for embedded wallets, if one exists
  - authenticating the API with a credential Privy will not exchange (for example Privy identity tokens, if the exchange rejects them), so the server never holds an exchangeable access token
  - a U that is not Privy-custodied (an external wallet), at the cost of the embedded-wallet experience

## Environment

| Variable | Where | Secret |
|---|---|---|
| `ANTARA_GUARDIAN_AUTH_KEY` | server only: `server/.env` and Render | **yes**: base64 PKCS#8 P-256 key. A `wallet-auth:` prefix is accepted. |
| `ANTARA_GUARDIAN_SOLANA_WALLET_ID` | server | no |
| `ANTARA_GUARDIAN_SOLANA_ADDRESS` | server | no |
| `ANTARA_GUARDIAN_POLICY_ID` | server | no |
| `ANTARA_GUARDIAN_SIGNER_ID` | server | no |
| `ANTARA_GUARDIAN_OWNER_QUORUM_ID` | server; **required** (the wallet's owner must equal it) | no |
| `DATA_DIR` | server; **required in production** (Render persistent disk mount) | no |
| `ANTARA_VAULT_STORE_INIT` | server; set to `1` for **one** start on a fresh disk, then remove after that start logs `initialised` | no |
| `ANTARA_PAIRED_VAULTS_ENABLED` | server; owner switch, **off unless exactly `true`**. Set it only after both go-live gates are recorded in `docs/VERIFICATION.md`. | no |
| `SOLANA_CLUSTER`, `SOLANA_RPC_URL` | server (existing) | the RPC URL may hold a provider key |
| `ANTARA_GUARDIAN_MAX_APPROVALS_PER_HOUR`, `ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_HOUR`, `ANTARA_GUARDIAN_MAX_APPROVALS_PER_USER_DAY` | server, optional | no |
| `VITE_ANTARA_GUARDIAN_SOLANA` | client build (public pin) | no |

If the owner switch is off, or any guardian variable is missing, the Solana vault routes answer `503` with code `not-provisioned` and a fixed message, and nothing is created, shown or approved. If one is malformed, they answer `503` with code `unavailable`, and the server log names the variable, never its value.

## Owner provisioning

Use the Privy **dev** app first, then repeat for prod. Every step is done by you; nothing runs automatically.

1. **Privy dashboard (each app)**
   - Wallets → Advanced shows **TEE enabled**.
   - Authenticator-app (TOTP) MFA is ON.
   - Solana embedded wallets are created for all users.
   - Delegated actions (session signers) for embedded wallets stay **off**. Paired vaults refuse delegated wallets.
2. **Offline admin key** (preferably on an offline machine). Run:

   ```
   node scripts/provision-guardian.mjs --generate-admin-key <offline path>
   ```

   Keep the private key file offline (password manager or hardware). Only its public key is used below.
3. **Dry run** (no network, no keys, no files):

   ```
   node scripts/provision-guardian.mjs --admin-public-key <base64> --dry-run
   ```

   Review the four planned calls:
   - `keyQuorums().create` for the owner quorum (2 of 2)
   - `keyQuorums().create` for the signer quorum (1 of 1)
   - `policies().create`, owned by the owner quorum, with Squads `proposal_approve` rules only (no ComputeBudget)
   - `wallets().create` with `owner_id`, `policy_ids` and `additional_signers[{signer_id, override_policy_ids}]`
4. **Provision**

   ```
   node scripts/provision-guardian.mjs --admin-public-key <base64> --write-env
   ```

   Use `--key-out <path>` instead of `--write-env` to write a 0600 file.
   - **Before creating anything,** the script checks the credentials with a read-only call.
   - **The server private key is stored first:** a secret is written only to a git-ignored file or to a path outside the repository.
   - **Output:** public ids and addresses only, including the owner quorum id (`ANTARA_GUARDIAN_OWNER_QUORUM_ID`, now required).
   - **Safety:** `--write-env` refuses to run if `server/.env` already has guardian variables.
   - **API:** every call uses the installed `@privy-io/node` 0.35.0 methods, so no direct REST calls are needed. The SDK targets these endpoints: `POST https://api.privy.io/v1/key_quorums`, `POST /v1/policies`, `POST /v1/wallets` and `POST /v1/wallets/{id}/rpc`.
5. **Go-live gates:** run both checks in [Go-live gates](#go-live-gates) locally, with the values `--write-env` stored, and record the output in `docs/VERIFICATION.md`. If either fails, stop here.
6. **Render** (paired vaults stay **off**: do not set `ANTARA_PAIRED_VAULTS_ENABLED` yet)
   - Add the server variables above. `ANTARA_GUARDIAN_AUTH_KEY` is a secret.
   - Attach the persistent disk and set `DATA_DIR`.
   - For the **first** deploy on a new disk, also set `ANTARA_VAULT_STORE_INIT=1`. The server opens the store at start-up, whether or not the guardian is configured. Remove the variable only after that start's log shows `{"event":"antara.vault-store","outcome":"initialised"}` (or `ready`), or after confirming in the Render shell that `$DATA_DIR/paired-vaults-solana.initialised` exists. Never set it to recover from a `refused` line: a refusal means the disk, the mount or `DATA_DIR` is wrong, or data was lost.
   - Set `VITE_ANTARA_GUARDIAN_SOLANA` for the client build.
   - With the switch off, every Solana vault route answers `503 not-provisioned`, so nobody can activate or deposit yet.
7. **Fund G** with a small SOL float (for example 0.02 SOL). It pays about 5000 lamports per vote.
8. **Switch on, last:** only when both gates are recorded as passing in `docs/VERIFICATION.md`, set `ANTARA_PAIRED_VAULTS_ENABLED=true` on Render and redeploy. From then on every signed-in user is offered activation. To pause new activity, remove it again; the routes then answer `not-provisioned`, and funds already in vaults wait on-chain until it is switched back on.
9. **Funded acceptance** (mainnet, tiny amounts):
   1. Activate with TOTP enrolled.
   2. Deposit 0.01 SOL and 1 USDC.
   3. Release to your own linked wallet.
   4. Confirm that executing without G's vote fails.
   5. Turn on Limits with a small cap and confirm that a release above it is denied; turn Limits off and confirm the cap no longer applies.
   6. Confirm that a release to a wallet not linked to your account is refused.

To rotate the guardian, provision a new one. Vaults are bound on-chain to the old G, which still votes only while the server is configured with it. Existing vaults need a configuration change approved by both U and the old G, and that path is not implemented. Until it is, keep the old guardian configured, or move funds out first. Rotating only the server key is described under [Model](#model).

## Go-live gates

Do not set `ANTARA_PAIRED_VAULTS_ENABLED=true` until both gates pass and are recorded in `docs/VERIFICATION.md`.

1. **Guardian policy (`--verify-policy`)**

   ```
   node scripts/provision-guardian.mjs --verify-policy
   ```

   - It uses the 1-of-1 signer key alone. It only signs, never broadcasts, throwaway transactions that use a random multisig and blockhash.
   - A `proposal_approve` must be signed (positive control).
   - Each of these must be refused **with a Privy policy violation** (`400`, code `policy_violation`). Any other error, including an unrelated `4xx`, is reported as FAIL because it proves nothing:
     - a SOL transfer
     - `proposal_approve` plus a SOL transfer in one transaction
     - a ComputeBudget-only transaction
     - `proposal_approve` with a priority fee
     - `proposal_reject`, `proposal_cancel` and `proposal_create`
     - `signMessage`
     - `rawSign` with `hash` set to a serialized SOL-transfer message (if signed, that would be a valid transfer signature)
     - `rawSign` with `bytes` set to that message and `hash_function: sha256`
     - the `transfer` action for 1 lamport (to G itself, so even a wrong allow moves nothing but a fee)
   - `exportPrivateKey` and `exportSeedPhrase` with the signer key alone must be refused with a policy violation or an authorization refusal (`401`/`403`). If an export succeeds, the key was exposed: provision a new guardian.
   - If the `transfer` case fails only because G holds no SOL, fund G with about 0.002 SOL and run the check again.
   - Do not enable releases if any line says FAIL.
2. **Server cannot act as U (`--probe-user-jwt`)**

   ```
   node scripts/provision-guardian.mjs --probe-user-jwt <file with a dev-app TEST user's access token>
   ```

   - Use a test user of the **dev** app, never a real user. Delete the token file afterwards.
   - It first asks Privy's user-JWT exchange for a session key for that user's wallets (the step behind `user_jwts`). The returned key is discarded unread. It then tries a harmless `signMessage` and a `signTransaction` with a random blockhash (never broadcast) as U.
   - PASS needs the exchange to be refused by Privy and nothing signed. Anything else blocks go-live; see [Trust model](#trust-model-and-what-a-compromised-server-can-do).

## What is honest to claim

You can say:
- "Vault releases need two signatures: your wallet and ANTARA's guardian."
- "On Solana the guardian can only vote. It cannot start or execute a transfer."
- "ANTARA co-signs only single SOL or USDC releases to your own wallets linked to your account, within any caps you set."
- "Both keys are held by Privy: your wallet as a Privy embedded wallet, and the guardian as an ANTARA server wallet."
- "The guardian key is held in Privy's secure enclave and can sign only Squads votes under a Privy policy." Say this only after `--verify-policy` passes.
- "ANTARA's servers cannot sign with your wallet." Say this only after `--probe-user-jwt` passes on each Privy app, and only while delegated signing stays off.
- "If ANTARA is unavailable, vault releases pause."
- "**If you lose access to your ANTARA login, vault funds cannot be released.** U is your Privy wallet and the guardian can only vote, so there is no recovery owner in this version."
- "Spending-wallet funds are not protected by the vault."

Do not claim:
- that the vault protects you against a compromised ANTARA server, until `--probe-user-jwt` passes
- per-transaction MFA (Privy caches MFA for about 15 minutes)
- geofence, device or biometric enforcement as live: the protection layers are implemented but not switched on; once live, claim only what [VAULT_LAYERS.md](VAULT_LAYERS.md) §14 allows, only while `GET /solana/layers` answers 200 and the layer is enrolled
- voice or USB checks (not offered)
- that a stolen session cannot touch the layers: it can schedule a recovery passkey that takes effect after 7 days unless you cancel it ([VAULT_LAYERS.md](VAULT_LAYERS.md) §3)
- "cannot be hacked"
- "gas-free"
- amount protection if your own Privy wallet is compromised. Someone who controls U and passes your layers (including your TOTP code if MFA is on) can release everything, or up to any caps you set, to your own linked wallets, which they would then control. ANTARA sets no cap of its own.
- that funded acceptance has passed

## Known limits

- **Ledger loss is detected, not prevented.** A missing store with its marker present, or an uninitialised store in production, refuses (`503`). If the whole disk is wiped while `ANTARA_VAULT_STORE_INIT=1` is still set, the store is re-initialised and the per-day usage counted against user-set caps resets; that is why the variable must be removed after the first start. Registrations can be rebuilt by registering each vault again, which re-verifies it on-chain.
- **Reservations count even when signing fails.** A reservation still counts toward any user-set caps and the per-account vote rate limit if Privy signing later fails. This is conservative and is intended.
- **One process only.** The store lock and the global vote counter are in-process, so run a single instance. A Render disk enforces this. The global counter resets on restart; the per-account vote rate limits come from the persistent ledger.
- **Limits are optional and set by the user (owner decision 2026-10-13).** A vault has no cap until the user sets one with `limits.set` (any positive amount, no server ceiling). Setting or lowering a cap applies at once; raising or removing one, or turning Limits off, also applies at once but needs every enabled layer.
- **Protection layers are not live.** They are enforced in code and tests only; the §15 hardware checks and funded acceptance are open, and the open owner decisions D1 to D4 are in [VAULT_LAYERS.md](VAULT_LAYERS.md) §16.
- **USDC releases are mainnet-only.** The USDC mint is pinned to the mainnet mint; on devnet only SOL can be released.
- **Delegation flags.** `delegated` and `user_can_sign` are read from Privy's user record. Whether Privy's newer session-signer feature always sets `delegated` should be confirmed during acceptance.
- **No priority fee.** The guardian vote includes no priority fee. Under heavy congestion it can expire; the client should retry after the 90-second pending window, and the retry is idempotent.
- **Server-key rotation is manual.** See [Model](#model).
- **Recipients must be visible on the device.** The client offers a release recipient only if the server lists it **and** the wallet context on this device shows it (the ANTARA embedded wallet or a wallet connected in this app). A linked external wallet that is not connected here is not offered until the wallet context exposes Privy's linked accounts (a change owned by the wallet workstream).
- **No in-app reject or cancel.** A proposal ANTARA refuses to vote on (for example after caps changed between proposing and the vote) stays open on-chain with its rent. The UI blocks the known refusals (TOTP, wallet pairing, user-set caps) before proposing, but offers no reject or close action yet.

## Required shared edits

Items 1 to 7 are done (2026-10-12; items 5 and 7 in the integration pass). Item 8 is half done (2026-10-13).

### 1. `server/src/solares/pairedVault.ts` (routes): done

All routes sit behind the router's existing pre-auth limit, Privy authentication and per-account limit (60 per minute). Register and approve add a 10-per-minute per-account limit. Every answer is `Cache-Control: no-store`.

| Route | Answer |
|---|---|
| `GET /solana/config` | `{configured: true, guardian, cluster, policyVersion}`. Since 2026-10-13 it carries no `limits`: there are no server release caps, and a vault's optional caps are reported by `GET /solana/layers`. It proves the Privy binding and reads the store first. |
| `GET /solana/account` | `{mfaEnrolled, wallets, vaults}` for the caller, read fresh from Privy. `wallets` lists each linked Solana wallet with `embedded` and `pairProblem` (why it cannot be U, or null). Since 2026-10-13 there is no `receivesReleasesFrom`: every linked wallet can receive releases as soon as it is linked. The client uses the list to show recipient eligibility before anything is signed. |
| `GET /solana/vaults` | `{vaults}` registered to the caller. |
| `POST /solana/register` | `guardian.register`. TOTP is checked before any chain read. |
| `POST /solana/approve` | `guardian.approve`: `approved`, `pending` or `already-approved`. TOTP is checked before any chain read. |
| `GET /limits?multisig=` | `{multisig, limits: {perReleaseRaw, perDayRaw}, usedLast24h}`: the caps the user set for that vault through the optional Limits layer (raw units; `null` = no cap, all `null` while Limits is off) and what the vault released in the rolling day a daily cap counts. Since 2026-10-13 there are no server caps. |

Errors:

- **Switched off or not configured** (`ANTARA_PAIRED_VAULTS_ENABLED` not exactly `true`, any guardian variable missing, or no `solanaGuardian` dependency): `503 {code: 'not-provisioned'}`, with a fixed message that names no variable.
- **Any other setup problem** (malformed variable, Privy credentials, `DATA_DIR`, limits): `503 {code: 'unavailable'}`. The server log names the setting, never its value.
- **`GuardianError`:** its own status and code (`400`, `403`, `409`, `429` with `Retry-After: 60`, `503`).
- **Anything else:** a generic `503`.
- **Changed from the earlier draft:** a binding or storage failure on `/solana/config` is now `503 {code: 'unavailable'}`, not `200 {configured: false}`. Clients treat both as "vault protection unavailable".

`GET /` (EVM ARK Safe discovery) is unchanged. For `chain=solana` it still answers `unsupported`, with a message pointing to the Solana routes.

Tests (`server/src/solares/pairedVault.test.ts`) use the real guardian service and policy with faked Privy, RPC and clock, and storage in a temporary directory. They cover:

- `401` before every route, with no guardian built
- `503 not-provisioned` without naming settings, including while the owner switch is off (unset, `false`, `1`, `yes` or `TRUE`) with every guardian variable present
- status mapping and no leaked error text
- config, limits and account facts
- missing MFA `403` before any chain read
- a foreign wallet `403`
- six wrong member, threshold or authority sets `403`
- registration and idempotent re-registration
- approve: approved, then `pending`, then `already-approved` with exactly one vote
- over a user-set cap `403`
- another account `403`
- lost TOTP `403`
- another account's in-flight approve request for the owner's (public) multisig and index never blocks the owner, while the owner's own concurrent request still gets `409`
- the store is opened once when the router is built, before and independent of the guardian, and the boot log says `refused`, `initialised` or `ready` without the disk path
- the per-account write rate limit

`guardian.ts` gained `account()` and the early TOTP checks.

### 2. `server/src/index.ts`

No change is needed. The router is already mounted at `/api/solares/paired-vault`, and `express.json({limit: '256kb'})` already runs before it. Keep `ANTARA_ENABLE_LEGACY_API=false`.

### 3. `render.yaml`: done

It now has the `antara-data` disk (`/var/data`, 1 GB) and `DATA_DIR=/var/data`, with all six `ANTARA_GUARDIAN_*` variables and `VITE_ANTARA_GUARDIAN_SOLANA` set as `sync: false`. Comments list the production origins for `WEB_ORIGIN` and `ALLOWED_ORIGINS`. `ANTARA_VAULT_STORE_INIT` is deliberately **not** in the file; set it by hand in the dashboard for the first start only, and remove it after that start logs `initialised`. The owner switch `ANTARA_PAIRED_VAULTS_ENABLED` is listed as `sync: false` and stays unset (off) until both go-live gates are recorded.

A Render disk pins the service to one instance and adds brief downtime on each deploy. The owner approved the disk on 2026-10-12.

### 4. `package.json` (root): done

`test:unit` includes `src/solares/paired/*.test.ts`, and `test:config` includes `scripts/provision-guardian.test.mjs`.

### 5. `.env.example`, `server/.env.example` and `doctor`: done

- `.env.example`: done. It has `VITE_ANTARA_GUARDIAN_SOLANA=` (the public guardian pin). Packaged desktop and extension production builds must set it, together with `VITE_API_BASE=https://antara.tech`.
- `server/.env.example`: done. It lists the six guardian variables with empty values, `ANTARA_PAIRED_VAULTS_ENABLED=` (off), the optional `ANTARA_GUARDIAN_MAX_APPROVALS_PER_*` vote rate-limit overrides with their defaults and ceilings (the former `ANTARA_VAULT_*` release caps were removed by the owner decision of 2026-10-13), and a commented `# ANTARA_VAULT_STORE_INIT=1` (first start on a new disk only).
- `scripts/doctor.mjs`: done. `PAIRED_VAULT_GUARDIAN` reports the guardian settings present or missing by name (a warning while the switch is off, a failure when it is on), `ANTARA_PAIRED_VAULTS_ENABLED` reports the switch, and `GUARDIAN_PIN_MATCH` checks that `VITE_ANTARA_GUARDIAN_SOLANA` equals the server address when either is set. No value is printed; `scripts/doctor.test.mjs` covers it.

### 6. Client: done

- **`src/solares/vaults/pairedApi.ts`** holds the build pin `PAIRED_GUARDIAN_SOLANA` (from `VITE_ANTARA_GUARDIAN_SOLANA`), instead of `wallet/config.ts`. It also holds strict parsers for every route. They refuse:
  - a guardian other than the pin, a build without a pin, another cluster, or another policy version
  - inconsistent limits
  - a registered deposit address that does not derive from its multisig
  - malformed approvals
- **`src/solares/vaults/validation.ts`:** `validatePairedVault` checks exactly {U:7, G:2}, threshold 2, no config authority, a time lock of exactly 0 and the pinned guardian. `validateVaultPolicy` is unchanged, so independent-owner vaults keep their stricter rules.
- **`src/solares/vaults/solana.ts`:**
  - `verifyPairedSolanaVault`, `createPairedSolanaVault` and `depositPairedSolanaVault`.
  - `proposePairedSolanaRelease`: one transfer, with ATA creation in the outer transaction, a required device-side `allowedRecipients` list (any other recipient is refused before anything is read or signed), and a client pre-check of any caps the user set.
  - `readPairedSolanaProposal`, which uses the shared decoders.
  - `waitForPairedApproval`: bounded polling.
  - `executePairedSolanaRelease`, which also refuses a proposal paying anyone outside U and the device-side recipient list.
  - The pin is checked before any network read.
  - `createPairedSolanaVault` sends `buildPairedCreateInstruction`: a fresh random `createKey`, members U:7 and G:2, threshold 2, time lock 0, no config authority, rent back to U and memo `ANTARA paired vault v1`. A unit test decodes the instruction data with the Squads coder, checks every field, and checks that two calls use different `createKey`s. Its `onPrepared` callback hands over the multisig address before signing, so an interrupted activation can be finished.
- **`src/solares/vaults/PairedSolanaVault.tsx`**, used by `WalletVault.tsx` for Solana. It shows these states:
  - signed out
  - loading
  - error with retry
  - no build pin
  - guardian not provisioned (explained, no vault shown)
  - wallet not eligible (not the embedded wallet, or delegated)
  - TOTP not enrolled (Privy `enrollMfa`, then check again)
  - activate
  - finish an interrupted activation
  - a vault on a previous guardian (releases paused)
  - active

  When active, it shows the verified SOL and USDC balances and deposit address, deposit, release to the user's own wallets (offered only when the server lists them as linked and this device also sees them; the default is U), a review step with the full recipient address before U signs, any caps the user set with what is left of a daily cap, and propose → request ANTARA's approval → wait for the on-chain vote → execute. Release and Continue are disabled, with the reason, while TOTP is not enrolled or U is no longer a valid paired wallet. Explorer links use `ExternalLink`, so they open in the desktop app and the extension. The step in progress is saved on this device so it can be resumed. The deposit address appears only after registration succeeds **and** the chain verifies the vault.
- **EVM networks** keep read-only ARK discovery and say "EVM vault coming next".

### 7. Docs: done

- `docs/SECURITY.md`: done (section "Paired vaults (October 2026)", including the trust-model caveat).
- `docs/HANDOFF.md`: done (the decisions, the owner steps and the trust-model caveat: the 2-of-2 is unverified against a compromised server until `--probe-user-jwt` passes).
- `docs/VERIFICATION.md`: done for the automated evidence; the two go-live gates `--verify-policy` and `--probe-user-jwt` are recorded as not yet run. Record their output when they are run, before `ANTARA_PAIRED_VAULTS_ENABLED` is set.

### 8. Vault browser tests: partly done

- Done (2026-10-13): `tests/fixtures/wallet.tsx` now uses a valid base58 Solana address. The layer panels have their own browser fixture (`tests/fixtures/layers.{html,tsx}`, tests in `tests/browser/wallet.spec.ts`), and `src/solares/layers/endToEnd.test.ts` runs the layer flow headlessly against the real routes.
- Open: add a pinned-guardian fixture build (`VITE_ANTARA_GUARDIAN_SOLANA` set) with mocked `/solana/config`, `/solana/account` and `/limits` routes. Cover `not-provisioned`, TOTP, activate and active, including the recipient review step and a server-listed recipient the device does not know, which must not be offered.

## Sources

- Privy policies overview (deny by default; every Solana instruction is evaluated): https://docs.privy.io/controls/policies/overview
- Privy Solana IDL policies (`solana_instruction_data`, Anchor 0.30+ IDL): https://docs.privy.io/controls/policies/example-policies/solana-idls
- Privy owners, signers and key quorums: https://docs.privy.io/controls/authorization-keys/owners/overview
- Privy two-of-two server-in-the-loop recipe: https://docs.privy.io/recipes/wallets/two-of-two-server-in-the-loop
- Privy user keys from access tokens ("If your app uses Privy as your authentication provider, you can skip this step"): https://docs.privy.io/controls/authorization-keys/keys/create/user/authentication
- Privy stateful policies (policy denials are `400` with code `policy_violation`): https://docs.privy.io/recipes/wallets/stateful-policies
- Squads approve-proposal instruction: https://docs.squads.so/main/development/typescript/instructions/approve-proposal
- Installed SDKs: `@privy-io/node` 0.35.0 (`wallets().solana().signAndSendTransaction / signTransaction / signMessage`, `wallets().rawSign / transfer / exportPrivateKey / exportSeedPhrase / authenticateWithJwt`, `keyQuorums().create / get`, `policies().create`, `wallets().create / get`, `users()._get`, `authorization_context.user_jwts`), and `@sqds/multisig` 2.1.4.
