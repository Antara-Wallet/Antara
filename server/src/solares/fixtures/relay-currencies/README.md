# Relay currency fixtures (captured 2026-10-13)

`currencies.json` holds live responses from Relay's public `POST https://api.relay.link/currencies/v2`.
They were captured read-only on 2026-10-13 between 20:34 and 20:40 local time (UTC-6), which is
02:34 to 02:40 UTC on 2026-10-14. No API key, login, signature or transaction was involved. The
capture made 22 requests, spaced 1.1 seconds apart. Each entry stores the exact request body,
the HTTP status and the unmodified response body.

They are the evidence for the destination-token check in `server/src/solares/relay.ts`
(`verifyDestinationToken`) and are replayed by `server/src/solares/relayTokens.test.ts`.

## What they show

- With `useExternalSearch: true`, Relay names Robinhood Chain's native ETH (the zero address) `WETH`.
  Without external search it returns `ETH`. The old check used external search only and required an
  exact ticker, so every Robinhood Chain swap to ETH sent as a token object was refused before quoting.
- Robinhood Chain stock tokens are lower case in Relay's own list and default list (`nvda`, `spy`)
  and upper case with external search (`NVDA`, `SPY`). Solana BONK is `BONK` in Relay's own list
  and `Bonk` with external search.
- Some tokens resolve only with external search. `base-bomi-*` is one: Relay's own list returns `[]`.
- Pinned assets (native coins, USDG, Binance-Peg USDC at 18 decimals) are listed for reference. The
  check no longer looks them up and compares them with the network registry instead.

To refresh, repeat the requests in `cases.<name>.request` against the same public endpoint, with
no API key, and replace the file. Keep the request bodies identical, because the tests match on them.
