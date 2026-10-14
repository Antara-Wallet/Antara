# Relay order fixtures (captured 2026-10-12)

These are live responses from Relay's public `POST https://api.relay.link/quote/v2`, captured
read-only on 2026-10-12 between 21:33 and 21:38 local time (UTC-6), which is 03:33 to 03:38 UTC on
2026-10-13. They are the evidence for `docs/RELAY_POLICY_2026-10.md`. No API key, login, signature,
approval or transaction was involved, and no funds moved. The capture made 13 HTTP requests in
total: 12 quotes and 1 `GET /chains`, spaced 1.5 seconds or more apart.

## How they were requested

Each quote body has the fields of `relayQuoteRequest(intent)` in `server/src/solares/relay.ts`,
with the same values except for the letter-case difference described below: `user`, `recipient`,
`originChainId`, `destinationChainId`,
`originCurrency` (the source funding stablecoin), `destinationCurrency`, `amount`,
`tradeType: "EXACT_INPUT"`, `slippageTolerance`, `refundTo: user`, `includeProtocolData: true`,
`explicitDeposit: true`, `forceSolverExecution: true`, `usePermit: false`,
`useDepositAddress: false`, `ttl: 120`. The exact body for each route is stored under
`routes.<name>.request` in `manifest.json`.

One difference is letter case only. For the three routes to a custom EVM token
(`solana-usdc-to-base-usdc`, `base-usdc-to-base-aero` and `solana-usdc-to-base-aero`), the capture
sent `destinationCurrency` as the EIP-55 checksummed address. `relayQuoteRequest(route.intent)`
builds the lowercase address that `intent.destinationToken` holds. Each of those manifest entries
records this under `builderDifference`. Relay returned the lowercase address in the order and in
`details`, so the order ids and every validator check are unaffected. A test that compares
`relayQuoteRequest(route.intent)` with `route.request` must compare EVM addresses
case-insensitively and Solana addresses exactly. Every other field matches exactly.

One file is an experiment, not an ANTARA request shape:
`experiment-refundOnOrigin-base-usdc-to-solana-sol.json` adds the deprecated
`refundOnOrigin: true` to show whether Relay then drops the destination refund option. It does
not: the order is unchanged in shape. Never use this file as an accept case for the request
builder.

## Placeholder addresses (not substituted)

| Placeholder | Role | Origin |
| --- | --- | --- |
| `0xe466C456eF161E378D5a1C4dc5BfdbF10172D9dD` | EVM `user`, `recipient` and `refundTo` on every EVM leg | 20 random bytes. No private key is known for it. |
| `9cxezhPUDpfQagzQ8GENnnMiHN4wYxdc36MSJ5LT8oMi` | Solana `user`, `recipient` and `refundTo` on every Solana leg | Public key of a random Ed25519 keypair. The secret key was discarded at generation and never stored. |

The responses contain these addresses exactly as sent. They were **not** replaced with other
placeholders afterwards. The order id commits to every recipient through an EIP-712 hash, and the
EVM `depositErc20` calldata and the Solana `deposit_token` instruction both embed that id, so any
substitution would break `getOrderId`, the client integrity check, and the deposit decoding that
the tests need. Neither address belongs to a real user. **Never send funds to either one.**

Same-VM routes use the same address as `user` and `recipient`. Cross-VM routes pair the EVM
placeholder with the Solana placeholder.

## Files

| File | Route | Family |
| --- | --- | --- |
| `solana-usdc-to-solana-sol.json` | Solana USDC to SOL | same chain, native output |
| `solana-usdc-to-base-usdc.json` | Solana USDC to Base USDC | cross chain, destination funding token |
| `base-usdc-to-solana-sol.json` | Base USDC to Solana SOL | cross chain, destination native |
| `bsc-usdc-to-bsc-bnb.json` | BSC Binance-Peg USDC (18 decimals) to BNB | same chain, native output |
| `robinhood-usdg-to-robinhood-eth.json` | Robinhood Chain USDG to ETH | same chain, native output |
| `ethereum-usdc-to-solana-usdc.json` | Ethereum USDC to Solana USDC | cross chain, destination funding token |
| `base-usdc-to-base-eth.json` | Base USDC to ETH | same chain, native output |
| `solana-usdc-to-solana-bonk.json` | Solana USDC to BONK | same chain, a token Relay's solver does not hold |
| `base-usdc-to-base-aero.json` | Base USDC to AERO | same chain, a token Relay's solver does not hold |
| `base-usdc-to-solana-bonk.json` | Base USDC to Solana BONK | cross chain, a token Relay's solver does not hold |
| `solana-usdc-to-base-aero.json` | Solana USDC to Base AERO | cross chain, a token Relay's solver does not hold |
| `experiment-refundOnOrigin-base-usdc-to-solana-sol.json` | as `base-usdc-to-solana-sol` plus `refundOnOrigin` | experiment only |
| `chains.json` | `GET /chains`, reduced to the five ANTARA networks and the fields the validator checks (`protocol.v2`, `contracts.erc20Router`, `solverAddresses`, `solverCurrencies`) | chain metadata |
| `manifest.json` | For each route: request body, `requestedAt` and `receivedAt` (epoch ms), the equivalent ANTARA `TradeIntent`, observed order id and deadline, and the values pinned across all captures | index |

Every quote input is 5 whole units of the source funding stablecoin: `5000000` at 6 decimals, or
`5000000000000000000` for Binance-Peg USDC on BSC.

## Using them in tests

- Order deadlines are absolute (roughly `receivedAt` plus 7 days). Pass
  `now = manifest.routes[name].receivedAt` to `validateQuote`, `validateReviewedQuoteWithoutSignature`
  and `verifyReviewedQuote`. Never use `Date.now()`, or every fixture expires on 2026-10-20.
  `server/src/solares/relayOrders.test.ts` is the regression suite built on these files.
- Before validating, run `normalizeQuoteApprovals` on a `structuredClone` of a fixture, as the server
  does. Never mutate the loaded object in place.
- For hostile mutations that must fail on **policy** rather than on the hash, recompute the order id
  after the change (`settlementOrderId(orderData)`) and replace the old id everywhere in the quote:
  `protocol.v2.orderId`, the deposit calldata, and the Solana instruction data. Keep separate
  non-rehashed cases to prove that the integrity check also fails.
- `protocol.v2.orderSignature` signs the original id only. A rehashed mutation also fails the
  signature check, so test the signature separately.

## Fidelity

Each response body was written with 2-space indentation. Before formatting, the capture checked that
`JSON.stringify(JSON.parse(raw)) === raw` for every body. The formatted files therefore hold the same
values as the wire bytes; all amounts are JSON strings, and no number exceeds 2^53. HTTP response
headers were not saved, and no API key was sent.

## Refreshing

Fixtures are dated evidence, not live truth. Relay may change its solver, deadline, refund options
or contracts. To refresh, replay the same request bodies from `manifest.json` (no key needed at
low volume, at most 1 request per second) and save the results under new files or a new folder.
Do not silently overwrite these files: if Relay's terms change, the old captures show what the
validator was built against.
