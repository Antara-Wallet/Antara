# ANTARA trading

ANTARA spends **the source network's funding stablecoin held in one selected wallet** to buy a selected token on Solana (primary), Ethereum, BSC (BNB Smart Chain), Robinhood Chain, or Base. The first release swaps only from that funding stablecoin. Same-network swaps are the default; the receive network can also differ, except that routes from another network into BSC or Robinhood Chain are not enabled yet (see [Order terms](#order-terms-owner-decision-october-12-2026-caps-removed-october-13-2026)). Search by token name or contract address. Metadata comes from Relay and each quote still requires sufficient liquidity and a supported, independently verified settlement order.

## Networks and funding stablecoins

Owner decision of October 12, 2026: Solana is primary, and Arbitrum (42161) and Polygon (137) are no longer supported. Routes to or from them must fail closed; saved records that mention them must stay readable. All values below are pinned in `src/solares/networks.ts`.

| Network | Relay chain id | Relay slug | Depository | Funding stablecoin |
| --- | --- | --- | --- | --- |
| Solana | `792703809` | `solana` | program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`, vault `7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ` | USDC (Circle) `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals |
| Ethereum | `1` | `ethereum` | `0x4cD00E387622C35bDDB9b4c962C136462338BC31` | USDC (Circle) `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals |
| BSC | `56` | `bnb` (not `bsc`) | `0x4cD00E387622C35bDDB9b4c962C136462338BC31` | USDC (Binance-Peg) `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, **18 decimals**, issued by Binance, not Circle |
| Robinhood Chain | `4663` | `robinhood` | `0x4cD00E387622C35bDDB9b4c962C136462338BC31` | USDG (Paxos Global Dollar) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| Base | `8453` | `base` | `0x4cD00E387622C35bDDB9b4c962C136462338BC31` | USDC (Circle) `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals |

Robinhood Chain has **no Circle USDC**. USDG is never labelled USDC, and an unverified bridged token there that calls itself USDC (`0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8`) is never accepted as funding. Relay also lists "Robinhood Lighter" (chain id `548123634`), a different venue; ANTARA never uses it. Binance-Peg USDC shares the USDC ticker but not Circle's issuance or decimals, so show "USDC (Binance-Peg)" wherever issuer or precision matters.

How this is enforced in code (integration pass, October 12, 2026): the API's `/chains` check (`verifiedChainMetadata` in `server/src/solares/relay.ts`) requires exactly one entry for each of the five chain ids, with the pinned slug and depository, and for Solana also the pinned `depositoryVault`; any drift or missing value fails closed, and the captured live `/chains` response passes it unchanged. Every funding surface of a quote must be the source network's pinned funding address, and a destination or search token that is on the lookalike list, or that uses the ticker USDC (or the network's funding ticker) at a different address, is rejected. `GET /api/solares/relay/config` returns the fields listed in the [endpoint table](#api-and-execution) (`mode: "verified-funding-origin"`, the 100,000-unit sanity ceiling, and `networks` with each funding address, symbol, label and decimals); the former `maxUsdc` field is gone. Saved swaps whose source or destination is Arbitrum or Polygon load read-only: they are never polled, refreshed or re-quoted, the swap screen shows them as "Not tracked" with an explorer link, and they cannot make saved history unreadable or block a new swap.

On October 12, 2026, read-only placeholder-address quotes for Base USDC→Robinhood ETH, Base USDC→Robinhood USDG, Robinhood USDG→Base USDC, BSC USDC→BNB and BSC USDC→Base USDC each returned an approval plus a deposit to the shared EVM depository, with order version `v1` and no extra calls. No login, signature or funds were involved. Twelve further read-only captures (`server/src/solares/fixtures/relay-orders/`) are the evidence for the order policy below.

## Spending boundary

The aggregate portfolio is a view of separate balances. It is not a pooled account. Vault balances are excluded from immediately spendable funds. Complete a multisig vault release into the user's spending wallet before requesting a fresh quote; never put a short-lived Relay quote into a delayed vault proposal.

## Configuration

Set these on the API server, using a local environment file or hosting secret manager:

```dotenv
PRIVY_APP_ID=
PRIVY_APP_SECRET=
RELAY_API_KEY=
```

Owner decision 2026-10-13: ANTARA sets **no swap cap**. The former `RELAY_MAX_TRADE_UNITS` and `RELAY_DAILY_MAX_UNITS` (alias `RELAY_MAX_DAILY_UNITS`) defaults and the per-account daily ledger were removed. The only amount bound is the pre-existing protocol sanity ceiling of **100,000 funding-stablecoin units per swap**, enforced by the shared validator.

Set public wallet configuration in the Vite app:

```dotenv
VITE_PRIVY_APP_ID=
VITE_API_BASE=http://localhost:8787
VITE_SOLANA_CLUSTER=mainnet-beta
VITE_SOLANA_RPC_URL=https://your-mainnet-rpc
VITE_SOLANA_WS_URL=wss://your-mainnet-rpc
```

Only the Privy **app ID** belongs in a `VITE_` variable. Never put the Privy app secret or Relay key there. Balance and wallet RPCs use `SOLANA_RPC_URL`, `ETHEREUM_RPC_URL`, `BSC_RPC_URL`, `ROBINHOOD_RPC_URL` and `BASE_RPC_URL` on the server (see [SECURITY.md](SECURITY.md#rpc-and-network-configuration)); `ARBITRUM_RPC_URL` and `POLYGON_RPC_URL` are no longer used. Since October 2, 2026, Relay requires an API key for every `/quote/v2` request. An API key is a production prerequisite, not an optional performance upgrade.

Express mounts the default export from `server/src/solares/relay.ts` at `/api/solares/relay`. It requires the normal JSON body parser and the existing ANTARA CORS configuration. Declare `@relay-protocol/settlement-sdk`, `@solana/web3.js`, and `viem` in the server dependency manifest; server validation imports shared frontend-neutral types and validators from `src/solares/relay`.

## API and execution

| Endpoint | Purpose |
| --- | --- |
| `GET /config` | Public configuration state, with no credential values: `configured`, `environment`, `mode: "verified-funding-origin"`, `maxFundingUnits` (the 100,000-unit protocol sanity ceiling per swap; no ANTARA cap since 2026-10-13), `fillWindowDays: 7`, `refundGuaranteed: false`, `swapLimitsError`, `networks` |
| `GET /currencies?chainId=…&term=…` | Public, rate-limited token metadata search; no signing or account access |
| `GET /api/solares/wallet/prices` (wallet router, `server/src/solares/prices.ts`) | Public, read-only USD prices of each network's native coin and funding stablecoin from Relay's `GET https://api.relay.link/currencies/token/price?address=&chainId=` (pinned registry addresses only; the native address is `11111111111111111111111111111111` on Solana and the zero address on EVM). 60-second cache shared by every caller (15 seconds when a price is missing), concurrent reads coalesced, 5-second timeout per read, 60 requests per minute per client IP. A price that is not a finite number inside its bounds (native coin $0.000001 to $10,000,000, stablecoin $0.50 to $1.50) is omitted, never invented; 503 when nothing is priced. `RELAY_API_KEY`, when set, is sent upstream only. Solana is not priced on a devnet server. Captured responses: `server/src/solares/fixtures/relay-prices` |
| `GET /chains` | Authenticated allowlisted chain metadata |
| `POST /quote` | Authenticated, ownership-checked, verified route |
| `GET /status/:requestId` | Authenticated settlement status |
| `GET /intents/status/v3?requestId=…` | Exact status endpoint used by Relay SDK |
| `POST /transactions/index` | Strict chain/hash notification after deposit |

The quote body accepts only `originChainId`, `destinationChainId`, `user`, `recipient`, `amount` (integer base units of the source network's funding stablecoin: 6 decimals, or 18 for Binance-Peg USDC on BSC), `destinationToken` (a token object with `chainId`, `address`, `symbol`, `name`, and `decimals`; legacy `USDC`/`native` selectors remain readable), and `slippageBps` (50 or 100). Both addresses must be linked wallets on the verified Privy account; any other recipient is refused before any Relay request. There is no link-age wait (owner decision 2026-10-13). Routes from another network into BSC or Robinhood Chain are refused by the shared validator (`receivingEnabled` in `model.ts`) and disabled in the receive-network and token-network selectors. ANTARA sets no swap cap (owner decision 2026-10-13); a swap above the protocol sanity ceiling of 100,000 whole units of the source stablecoin (checked at the stablecoin's own decimals, so 18 on BSC) is refused. The server constructs all other Relay parameters, including the original source wallet as `refundTo`, explicit deposits, solver execution (including same-network swaps), protocol data, and a requested 120-second platform TTL. That request does not establish the expiry encoded in the protocol order; the validator separately checks its deadline.

`TradeWorkspace` from `src/solares/relay/TradeWorkspace.tsx` consumes `useSolaresWallet`. Before **Confirm swap** it shows, from `describeSettlement` in `src/solares/relay/review.ts` (registry labels only, never quote-supplied symbols): the exact input with its token label and network ("5 USDG on Robinhood Chain", "5 USDC (Binance-Peg) on BNB Smart Chain"), the expected output and the minimum if filled, the receiving wallet, the fill window as a local date and time ("Until … (up to 7 days)"), every refund destination and token, the 90-second quote countdown (separate from the fill window), slippage, the network-fee limit, and "Public on-chain transaction". The paragraphs state that the stablecoin is held in Relay's depository until Relay fills or refunds the order, that ANTARA does not support protocol recovery in the app, and that the refund amount is not guaranteed by the order (it can be reduced by gas, not sent if smaller than gas, or be nothing). **Confirm swap** stays disabled until the user ticks "I understand this swap relies on Relay and I could receive less than I deposited, or nothing." Changing the amount, token, network, slippage, or account clears the review and the acknowledgement. An unreadable or unsupported `/config` keeps **Review** disabled. **Max** uses the full funding balance, limited only by the 100,000-unit sanity ceiling. Empty activity and decorative review panels are omitted; real pending submissions remain visible, and full history is in Activity. Privy performs signing. ANTARA never receives private keys.

The client uses Relay SDK 8 wallet adapters and the SVM adapter 22 to submit its narrowly validated approval/deposit sequence. ANTARA confirms an EVM approval within the quote validity window before allowing the deposit. After the deposit hash returns, it notifies the backend and hands off to persistent, read-only status tracking. SDK 8's generic settlement loop does not count `pending` responses toward its timeout, and its abort controller only suppresses progress callbacks; it is deliberately not used. No background settlement task retains permission to request another signature. Proxy requests use a fresh Privy bearer token and a 20-second timeout. Relay API credentials stay on the server.

The live Privy session ID and both selected route wallets are checked before every signing boundary and again after asynchronous preflight. EVM accounts and chain are re-read immediately before each send. Signing callbacks from an earlier session are invalidated by the wallet provider.

## Verification boundary

Both browser and API validate the route. The API also recomputes the settlement order hash with the official settlement SDK. Depository addresses are independently pinned and checked against fresh Relay `/chains` metadata. Quote-supplied addresses cannot replace the validator's expected contracts.

Accepted operations:

- EVM exact-amount ERC-20 approval to the canonical Relay depository, followed by `depositErc20` committing to the verified order ID. An upstream unlimited allowance is first decoded and checked for the exact source/token/spender, then reduced to the requested debit. The browser refuses any remaining oversized allowance. Existing sufficient allowances may omit the approval.
- Solana `deposit_token` to the canonical Relay depository, with the exact USDC mint, payer/depositor, derived depository/vault/associated token accounts, input amount, and order ID.
- Bounded Solana compute budget instructions and account-safe memos. Simulation runs before requesting the Solana signature.
- Destination token payouts bound by chain, contract address, amount, and recipient in the settlement order. Token decimals are checked against quote metadata and independently looked up by the API before quoting. The source wallet does not sign arbitrary destination DEX instructions.

Unknown signature steps, permit authorizations, origin swaps, additional Solana transfers/tips/programs, arbitrary destination calls, fee recipients, transaction suffixes, order versions, and new depository addresses are rejected. The supported order schema is the official documented `protocol.v2.orderData.version = "v1"`. A route using a new format needs an explicit validator update, not a bypass. Same-network swaps request `forceSolverExecution: true` because Relay otherwise defaults to directly executing DEX calldata. Only the verified deposit/order flow is accepted. Same-network requests from the funding stablecoin to itself are rejected. New token objects survive JSON serialization and history reloads without relying on object identity; older records retain their pinned token selectors.

EVM gas is estimated against the connected wallet provider just before each send. The gas limit (estimate plus 20%) may not exceed 1,000,000 gas units, and gas limit × max fee per gas may not exceed the source network's native-asset cap: **0.02 ETH** on Ethereum, Base and Robinhood Chain, and **0.01 BNB** on BSC. These caps are defined once in `evmNetworkFeeCap` / `MAX_EVM_GAS_LIMIT` in `src/solares/relay/model.ts`; treat that code as authoritative if this paragraph and the code ever disagree. The former 20 POL Polygon cap no longer applies because Polygon is unsupported. Solana priority fees are capped at 0.02 SOL (compute units × micro-lamports, checked in `src/solares/relay/validation.ts`). These limits do not replace the wallet's fee review. Source native gas is required; this integration does not promise sponsored execution.

## Activity, interruptions, and refunds

Request IDs, route parameters, timestamps, and transaction hashes are stored in `localStorage` under `solares.relay.activity.v1`. No authorization tokens or keys are persisted. `loadTradeHistory()` exposes the records; `solares:relay-activity` is dispatched after updates. The UI filters history to the selected wallet. This is device-local history, not a server ledger or guaranteed backup.

Active routes resume status polling when the user returns. `success` and `refund` are distinct. A network timeout or ambiguous wallet send remains `unresolved`; it does not become a fabricated failure/success. A saved swap whose deposit state is unknown (`waiting`, `depositing`, `unresolved`) always blocks another swap from the same source network. A known deposit (`pending`, `submitted`, `delayed`) blocks for 30 minutes after it was created; within that time, once Relay's status has reported the deposit, the record offers **Start another swap** behind one confirmation. A known pre-deposit cancellation records that no deposit was submitted, and notes that an already mined allowance may remain. Checking status never resubmits a deposit.

New records keep the signed settlement order (`order`: id, order data and solver signature), saved when the deposit signature is requested; older records without it still load. Because the order is saved before the wallet confirms, a saved order alone is not evidence of a deposit, so the fill-window line (`fillWindowNote` in `review.ts`) states custody only with deposit evidence (`pending`, `submitted` or `delayed`). With evidence, an open record shows "Relay can fill until …"; after the order deadline, a record that Relay has not reported as `success`, `refund` or `failure` is labelled **Not filled**: "Your deposit stays in Relay's depository until Relay refunds it or protocol recovery is used." Without evidence (`waiting`, `depositing`, `unresolved`, for example after the app closed during the wallet prompt or the wallet failed), the record keeps its own label ("Awaiting deposit", "Deposit confirming", "Status unresolved") and the wording stays conditional: "If your deposit was submitted, Relay can fill it until …", then after the deadline "Fill window ended {deadline}. Check status. If a deposit was made, it stays in Relay's depository until Relay refunds it or protocol recovery is used." ANTARA does not implement protocol recovery and never implies it can.

Every captured order carries two refund options with `minimumAmount: "0"`: one to the source wallet on the source chain in the source stablecoin, and one to the receiving wallet on the destination chain (in the output token, the destination stablecoin, or a duplicate of the first option). ANTARA accepts only those shapes and only to wallets linked to the user's Privy account (the source wallet, or the receiving wallet the server verified as linked to the same Privy account). A refund can be reduced by gas, is not sent when smaller than its gas, and, because the minimum is zero, Relay's solver can mark the order refunded while paying less than the deposit or nothing. The worst case for each swap is the loss of the whole deposit, which the review states before every swap. A refund paid through the destination alternative is recorded with destination-chain transaction evidence. A failed fill does not guarantee a refund; refund-specific errors stay visible. The deprecated `refundOnOrigin` flag is not used (a capture shows it changes nothing). Explicit `refundTo` is set because Relay's refund guide and older API-default prose differ about omission behavior.

## Validation and remaining live acceptance

`cd server && npx tsx --test src/solares/relay.test.ts` exercises bigint parsing, all configured chain/asset combinations, hostile approvals, calldata and payer substitution, minimum output/fill window, order-hash tampering, redirected refunds, arbitrary endpoints/calls, chain-metadata drift, and Solana instruction/account/fee attacks with deterministic synthetic fixtures. Synthetic orders cannot carry Relay's solver signature, so they use the synchronous validators only.

`cd server && npx tsx --test src/solares/relayOrders.test.ts` runs the policy against the 12 live captures: each is accepted (order hash by the browser verifier and the SDK, the synchronous policy at quote time and 90 s later, and the solver signature); 26 hostile mutations per capture are rejected on policy even after the order hash is recomputed (foreign refund recipient or currency, the pay-the-depositor sentinel, third-chain or missing origin refunds, three options, refund deadline/extraData/minimum, fill window too long or too short, calls, fees, depository and deposit-target substitution, solver and fill-contract substitution, off-chain hub, decimals, a USDG/USDC relabel, input weight); flipped, borrowed and stale signatures are refused; the Robinhood lookalike is refused as a refund currency; distinct user/recipient wallets bind the right refund option; a source scan keeps every signing path on `verifyReviewedQuote`; the review text and the `/quote` route with mocked Privy, clock and Relay HTTP (signature check, the 100,000-unit sanity ceiling, and recipients that must be linked to the same Privy account) are covered. `relay.test.ts` also checks that routes from another network into BSC or Robinhood Chain fail closed while saved records in those directions stay readable. `npx tsx --test src/solares/relay/review.test.ts` covers the client-side config parsing, source blocking and fill-window text, including records without deposit evidence. `npx tsx --test src/solares/relay/client.test.ts` runs `executeTrade` with a stub wallet on two captures whose solver signature has one digit flipped: it never calls the wallet or the network, saves no swap, refuses a concurrent second call, and releases its guard for a retry. These tests do not spend money.

`npx tsx --test src/solares/relay/execution.test.ts` verifies that an approval timeout or changed wallet session never advances to the deposit, and that settlement tracking is separated from signature submission.

On October 9, 2026, the supplied server API key was accepted by `/quote/v2` (HTTP 200), using a synthetic EVM address to request a 10 USDC Base→Arbitrum quote. All five live chain depositories matched the independently pinned addresses. No Privy user login, wallet signature, transaction submission, or funded mainnet transfer was performed. Arbitrum has since been removed from supported networks; the former blocker below concerned the order's deadline and refund terms, not the network.

## Order terms (owner decision, October 12, 2026; caps removed October 13, 2026)

**Former blocker, resolved by owner decision with disclosed risk.** Despite `ttl: 120`, Relay's canonical orders have a seven-day output deadline and two refund options with zero minimum refund amounts. The earlier validator allowed at most a ten-minute deadline and source-only refunds, so every live quote was rejected. On October 12, 2026 the owner decided to accept those terms with clear disclosure and refunds restricted to the user's own wallets; the small swap caps added with that decision were removed by the owner on October 13, 2026. The full specification, evidence and remaining limits are in [RELAY_POLICY_2026-10.md](RELAY_POLICY_2026-10.md). In short, the shared validator (browser and API) now requires:

- `output.deadline` more than 5 minutes and at most 7 days + 15 minutes away; every refund deadline equal to it;
- one or two refund options: an origin option to the source wallet in the source stablecoin (required, minimum at most the deposit) and at most one destination option to the verified receiving wallet in the destination stablecoin, its native asset or the output token, never a lookalike; any non-negative minimum, `0` included;
- `extraData` pinned per VM (Relay's EVM fill contract `0xb92fe925…4fff4f`, or `0x` on Solana), `hubType: "onchain"`, input weight `1`, and the funding token's symbol unchanged (USDG is never accepted as "USDC");
- Relay's solver `0xf70da978…a3dbef` on `base`, pinned, and the order signed by it (EIP-191 over the raw order id). `verifyReviewedQuote` is the single gate on the server and before every wallet request; a solver rotation fails closed until a reviewed update;
- unchanged: order-hash recomputation (browser and SDK), pinned depositories cross-checked against `/chains` (which must also list the pinned fill contract and solver), exact approval, `depositErc20` / `deposit_token` decoding, the Solana instruction allowlist and 0.02 SOL priority cap, per-network EVM fee caps, no calls, no fees, and the 90-second review window.

What validation cannot guarantee: that Relay fills or refunds at all, or how much a refund pays. With a zero refund minimum Relay's solver can settle as "refunded" while paying nothing, and after the deadline only Relay's protocol recovery (not implemented in ANTARA) can return an untouched deposit. The review states that exposure plainly and requires an acknowledgement before every swap; ANTARA no longer caps the amount (owner decision 2026-10-13), so the user decides how much to risk, up to the 100,000-unit sanity ceiling per swap.

**Remaining acceptance is owner-run.** No funded swap has been performed. With the owner's approval, run one small route (1 to 5 units: Solana USDC→SOL, then Base USDC→Solana SOL), then once on BSC and once on Robinhood (USDG), and record the deposit, the fill or refund, and the `/status` sequence in `docs/VERIFICATION.md`. Routes from another network into BSC or Robinhood Chain stay disabled until read-only captures of those destination legs (and of a cross-network route into a non-solver token there) are added to `relayOrders.test.ts`; same-network swaps on both, and routes out of them, are enabled. Unsupported routes continue to fail closed.

## Primary references

- [Relay API keys](https://docs.relay.link/references/api/api-keys)
- [Relay quote API](https://docs.relay.link/references/api/get-quote-v2)
- [Relay input/order validation](https://docs.relay.link/references/api/api_core_concepts/input-validation)
- [Relay refunds](https://docs.relay.link/references/api/api_core_concepts/refunds)
- [Relay status API](https://docs.relay.link/references/api/get-intents-status-v3)
- [Relay Solana support](https://docs.relay.link/references/api/api_guides/solana)
- [Canonical Solana depository source](https://github.com/relayprotocol/relay-depository/blob/main/packages/solana-vm/programs/relay-depository/src/lib.rs)
- [Official SVM wallet adapter](https://github.com/relayprotocol/relay-kit/tree/main/packages/relay-svm-wallet-adapter)
- [Circle USDC mainnet addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Sources and contract metadata checked October 8, 2026. BSC and Robinhood Chain metadata, depositories and funding tokens were checked read-only on October 12, 2026.

## October 12 interface and token discovery update

The wallet now has Portfolio, Swap, Activity, Protection, Vaults, and Settings. The main UI no longer exposes Agents, Browser, duplicate Tokens navigation, the legacy Private tab, or an always-present swap sidebar. Dormant legacy code and saved references are retained. The Protection screen only presents actionable controls; this does not activate any previously unimplemented protection.

The public currency endpoint was checked live without an API key using Base cbBTC metadata. Local unit/API tests cover custom currency validation, same-network order verification for all five networks of the earlier set (Ethereum, Base, Arbitrum, Polygon, Solana), token metadata substitution, bounded discovery requests, and history compatibility. Browser tests cover token selection, network changes, search errors, mobile layouts, and keyboard focus. No funded swap has been performed. The order-terms blocker described in earlier revisions was resolved by the owner decision above, with disclosed risk and caps. The current Relay flow is public on-chain and does not provide transaction privacy.

References for this update: [token discovery](https://docs.relay.link/references/api/get-currencies-v2), [quote parameters including solver execution](https://docs.relay.link/references/api/get-quote-v2), and [same-chain swaps](https://docs.relay.link/use-cases/cross-chain-swaps).
