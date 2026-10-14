# Relay price fixtures (captured 2026-10-14 UTC)

`prices.json` holds live responses from Relay's public `GET https://api.relay.link/currencies/token/price?address=<address>&chainId=<relay chain id>`.
They were captured read-only on 2026-10-14 between 05:00:52 and 05:01:01 UTC (2026-10-13 local, UTC-6).
No API key, login, signature or transaction was involved. The capture made 11 requests, spaced 0.6
seconds apart. Each entry stores the exact query, the HTTP status and the unmodified response body.

They are the evidence for the price route in `server/src/solares/prices.ts` and are replayed by
`server/src/solares/prices.test.ts`.

## What they show

- The endpoint answers `{"price": <number>}` in US dollars for the pinned native currency address
  (`11111111111111111111111111111111` on Solana, the zero address on EVM networks) and for each
  network's pinned funding stablecoin, including Binance-Peg USDC (18 decimals) and USDG.
- Ethereum, Robinhood Chain and Base native ETH return the same price.
- An address Relay cannot price answers HTTP 400 `{"error":"Could not get price"}`.
- Relay does not check that the chain id is a real chain: the zero address on chain `999999` returned
  the ETH price during exploration. ANTARA only ever asks about the pinned registry assets.

To refresh, repeat each `cases.<name>.request` against the same public endpoint with no API key and
replace the file. Keep the case names and requests identical, because the tests match on them.
