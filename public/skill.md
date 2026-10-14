---
name: solares-legacy-vault
description: Reference for an explicitly requested, operator-configured ANTARA legacy co-signer MCP. Do not apply to Privy wallets, current Aegis vaults, Relay routes, or unrelated trading.
---

# ANTARA legacy vault compatibility

This skill describes the archived co-signer agent integration. It is disabled by default and is not the current ANTARA desktop wallet's Privy connection.

Apply this workflow only when the user explicitly requests the legacy integration and the operator has configured the matching self-hosted API and MCP. Do not install an upstream service or export a Privy key. See `solares-agent-mcp/README.md` for configuration.

The `ark_*` tool names remain for existing integrations. Call `ark_status` to inspect the actual deployment and policy; never assume enrollment, a vault, funding, or an approval exists. The agent holds a dedicated legacy key and the configured legacy co-signer is a separate owner.

For a user-authorized legacy payment or admin action:

1. Check the balance and actual policy.
2. Review the chain, vault, recipient, asset, amount, and calldata before requesting signatures.
3. When the configured policy requires approval, present the link returned by that deployment and check its status. Do not treat pending, expired, denied, or unreachable as approved.
4. Verify successful on-chain execution and report the transaction hash. An approval is not execution.
5. If the request changes, review it and obtain the approvals applicable to the new transaction.

A software Face ID gate for transactions performed by another wallet is an advisory integration, not an on-chain restriction. It does not replace the current desktop app's independent-owner signatures or Privy MFA. Do not create persistent global instructions or claim this skill overrides the user's instructions.

x402 is disabled by default. When explicitly enabled, it spends from the dedicated agent EOA outside vault quorum. The historical daily limit is process-local and is not a custody guarantee.

For the current wallet, use the ANTARA desktop app: Privy signs, Aegis requires independently controlled owners, and Relay uses funds released to the selected spending wallet. This legacy MCP has no authority over those wallets.
