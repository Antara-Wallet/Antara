import type { ReactNode } from 'react';
import { DocLink, PageHead, Section } from '../components';

function Q({ q, children }: { q: string; children: ReactNode }) {
  return <details className="adocs-faq"><summary>{q}</summary><div>{children}</div></details>;
}

export default function Faq() {
  return <>
    <PageHead eyebrow="06 / FAQ" title="Questions and answers" lead="Short, honest answers. If an answer depends on something not live yet, it says so." />

    <Section id="general" title="General">
      <Q q="What is ANTARA, in one sentence?"><p>A regular wallet, plus a multisig vault you create from it and protect with security layers you choose.</p></Q>
      <Q q="Which networks does it support?"><p>Solana first, then Ethereum, BNB Smart Chain, Robinhood Chain and Base. The vault is on Solana today; an EVM vault is planned.</p></Q>
      <Q q="Does ANTARA hold my keys?"><p>No. Privy holds your wallet keys and asks you to confirm each signature; ANTARA never receives them. The vault&apos;s second member is ANTARA&apos;s guardian, which can only vote.</p></Q>
      <Q q="Is ANTARA audited?"><p>No. It is an implementation with automated tests. No security audit, no test with real funds and no hands-on hardware test of the layers has been completed.</p></Q>
      <Q q="Does ANTARA pay network fees?"><p>No. You pay network fees yourself. Gas sponsorship is <DocLink to="/docs/roadmap">planned</DocLink>, not built.</p></Q>
    </Section>

    <Section id="wallet" title="Wallet">
      <Q q="Will the wallet ask me for codes all the time?"><p>No. Your regular wallet never asks for an MFA code. MFA belongs to the vault alone and is optional: if you turn it on, the vault asks for a 6-digit code from your authenticator app when you release.</p></Q>
      <Q q="Why can I only swap from USDC?"><p>Each network has one pinned funding stablecoin (USDC, USDC (Binance-Peg) on BNB Smart Chain, USDG on Robinhood Chain). Paying from one known token keeps every quote checkable. Swaps from any token are planned.</p></Q>
      <Q q="What if a swap does not fill?"><p>Relay can hold your deposit for up to 7 days. If it does not fill, a refund goes to your own wallet, but its amount is not guaranteed: it could be less than you deposited, or nothing. That is why the review states it plainly and you must acknowledge it before confirming. Only swap an amount you can afford to lose.</p></Q>
      <Q q="Can websites connect to ANTARA?"><p>Not yet. Website connections stay off until our wallet provider confirms its terms allow it.</p></Q>
    </Section>

    <Section id="vault" title="Vault">
      <Q q="Can I use the vault today?"><p>Not yet. ANTARA&apos;s guardian is not switched on for antara.tech yet, so the Vault screen says so and no vault can be created there.</p></Q>
      <Q q="Can ANTARA take my vault funds?"><p>The guardian can only vote: it cannot start or execute a transfer, and it votes only for releases to your own wallets. Whether ANTARA&apos;s server could ever sign as your wallet has not yet been verified; that check must pass before go-live. See <DocLink to="/docs/vault#guardian">the guardian</DocLink>.</p></Q>
      <Q q="Can I release straight to an exchange or a friend?"><p>No. Releases go only to your own Solana wallets, linked to your ANTARA account. Release to your wallet, then send from it.</p></Q>
      <Q q="Is there a time lock or a cap on releases?"><p>No on-chain delay and no cap set by ANTARA. Releases are fast once both approvals are in. You can turn on Limits and set your own caps per release and per day. The only waiting period is the 7-day recovery for a layer you can no longer use.</p></Q>
      <Q q="What if ANTARA goes offline?"><p>Releases pause and your funds stay in the vault on Solana. A release in progress can continue when ANTARA is back.</p></Q>
    </Section>

    <Section id="layers" title="Security layers">
      <Q q="Do I need a fingerprint or face scan?"><p>You need a passkey. Your device decides how you unlock it: fingerprint, face, or the device PIN. ANTARA never receives biometric data.</p></Q>
      <Q q="Can my location be faked?"><p>Yes. Safe Zones is device-reported: a modified device or location spoofing can fake it. Use it as one layer among others, not as proof.</p></Q>
      <Q q="Why does Chrome warn that the extension can detect my location?"><p>The Safe Zones layer needs it, and Chrome does not allow that permission to be optional. Location is read only when your vault&apos;s Safe Zones layer needs a reading.</p></Q>
      <Q q="I am traveling. Will my vault lock me out?"><p>If Safe Zones or Wi-Fi is on, releases need a safe zone or network. Adding one applies at once, but it needs every layer you have on, so add it while you can still pass them. If Bluetooth is on, bring your trusted Bluetooth device and approve from an app you already set up: while Bluetooth is on, adding a new app needs a 7-day recovery that waives Bluetooth. Your regular wallet keeps working everywhere.</p></Q>
      <Q q="Does a VPN help or hurt?"><p>The Wi-Fi layer checks the public address your request comes from. A VPN changes it, so a VPN that does not exit at a trusted network fails that layer.</p></Q>
    </Section>

    <Section id="recovery" title="Recovery">
      <Q q="I lost the phone with my passkey."><p>Add a new passkey through a recovery change. It takes effect after 7 days and can be cancelled until then. If you have another passkey, use that one.</p></Q>
      <Q q="I lost access to my ANTARA login."><p>Then vault funds cannot be released. There is no recovery owner in this version. Privy&apos;s own account recovery may restore your login.</p></Q>
      <Q q="Someone may have my session. What can they do?"><p>Without your passkey and your other layers they cannot release. Weakening your protection needs every layer you have on. A recovery that skips a layer waits 7 days and shows a warning on your vault, where you can cancel it. ANTARA sends no notifications, so check the app.</p></Q>
    </Section>
  </>;
}
