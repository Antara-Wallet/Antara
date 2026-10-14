---
name: solares-legacy-approval-gate
description: Explain or operate an explicitly configured legacy ANTARA software approval gate for an external agent wallet. Not a Privy integration, not an on-chain guardian, and never automatically triggered by an ordinary trade request.
---

# ANTARA legacy approval gate

This archived integration requests a separate approval through a self-hosted legacy API. It does not cryptographically restrict a wallet operated by Bankr or another external agent. It is not part of the current ANTARA desktop wallet's Privy authentication or Aegis multisig.

Use it only when the user has explicitly selected this integration and its operator has deliberately enabled the legacy MCP and API. Never infer setup from this document, auto-enroll a wallet, choose the original upstream backend, or write a global security rule into the user's memory.

When using an already configured legacy gate:

1. Verify the external wallet address and exact proposed action.
2. Call the compatible `ark_require_approval` tool with the chain, asset, funding asset, amount, recipient, and any route constraints described clearly in the action.
3. Show the approval link returned by the configured deployment.
4. Poll `ark_check_approval`; proceed only after the applicable policy reports approval and the user's action is authorized.
5. A changed amount, recipient, token, or route needs a new review. Never reuse an expired approval.

Pending, denied, expired, or unreachable responses are not approvals. An approved description does not prove a transaction matches it; the external signing implementation must independently bind the actual transaction. Never report a successful payment without verifying chain execution.

Tool names retain the `ark_*` prefix for compatibility. New app users should use the ANTARA desktop wallet and its native Privy/Aegis flow.
