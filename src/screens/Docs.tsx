import { useEffect, useState } from "react";
import arkLogo from "../assets/landing/ark-logo.png";
import { XIcon, DownloadIcon } from "../components/Icons";
import { navigate, openExternal, X_PROFILE_URL, DOWNLOAD_URL } from "../lib/nav";

type Section = { id: string; label: string };

const SECTIONS: Section[] = [
  { id: "introduction", label: "Introduction" },
  { id: "why-ark", label: "Why ANTARA" },
  { id: "how-it-works", label: "How it works" },
  { id: "security-layers", label: "Security layers" },
  { id: "getting-started", label: "Getting started" },
  { id: "using-ark", label: "Using ANTARA" },
  { id: "recovery", label: "Backup & recovery" },
  { id: "threat-model", label: "Threat model" },
  { id: "faq", label: "FAQ" },
];

function Code({ children }: { children: string }) {
  return <code className="ark-doc-code">{children}</code>;
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="ark-doc-callout">
      <span className="ark-doc-callout-title">{title}</span>
      <div>{children}</div>
    </aside>
  );
}

export function Docs() {
  const [active, setActive] = useState(SECTIONS[0].id);

  // Scroll-spy: highlight the section currently in view.
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="ark-doc">
      <header className="ark-doc-top">
        <button className="ark-doc-brand" onClick={() => navigate("/")} type="button">
          <img src={arkLogo} alt="ANTARA" />
          <span>ANTARA</span>
          <span className="ark-doc-brand-sep">/</span>
          <span className="ark-doc-brand-docs">docs</span>
        </button>
        <div className="ark-doc-top-actions">
          <button className="ark-doc-pill" type="button" onClick={() => openExternal(DOWNLOAD_URL)}>
            <DownloadIcon size={16} />
            Download
          </button>
          <button
            className="ark-doc-icon-btn"
            type="button"
            aria-label="ANTARA on X"
            onClick={() => openExternal(X_PROFILE_URL)}
          >
            <XIcon size={16} />
          </button>
        </div>
      </header>

      <div className="ark-doc-body">
        <nav className="ark-doc-nav">
          <span className="ark-doc-nav-head">Documentation</span>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`ark-doc-nav-link ${active === s.id ? "is-active" : ""}`}
              onClick={() => go(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <main className="ark-doc-content">
          <section id="introduction" className="ark-doc-section">
            <p className="ark-doc-eyebrow">Overview</p>
            <h1>ANTARA is a programmable trust layer.</h1>
            <p className="ark-doc-lead">
              ANTARA is the trust layer for the agentic economy: the infrastructure
              humans, AI agents, and autonomous machines use to own, govern, and move
              value. Ownership is secured not by a single static key, but by
              cryptographic verification across identity, context, behavior, and
              quantum-resistant proofs. Static keys leak and signatures get spoofed.
              ANTARA replaces that fragile model with programmable, layered trust.
            </p>
            <p>
              Today that protocol ships as a non-custodial vault you fully own. Your
              keys are generated and held on your own machine and never leave it, and
              every transfer is co-signed by an independent ANTARA signer that only adds
              its signature once the protections you switched on prove the request is
              genuinely you. The same trust engine that secures a person will secure
              the agents and machines that act on their behalf.
            </p>
            <Callout title="In one sentence">
              You hold ownership, not a single point of failure. ANTARA refuses to sign
              until your chosen proofs pass, so a stolen key or a compromised machine
              is never enough on its own.
            </Callout>
          </section>

          <section id="why-ark" className="ark-doc-section">
            <h2>Why ANTARA exists</h2>
            <p>
              Software is becoming autonomous. AI agents, robots, and institutions
              will soon hold capital, credentials, and access to critical systems. A
              seed phrase is a single secret, and whoever holds it holds everything.
              That model was already fragile when attacks were manual. It does not
              survive a world where draining keys, spoofing signatures, and seeding
              malware run at scale and on autopilot.
            </p>
            <p>The two common answers both fail you in different ways:</p>
            <ul className="ark-doc-list">
              <li>
                <strong>Custodians</strong> hold your keys for you. They can be hacked,
                frozen, or compelled, and you are trusting a company with your money.
              </li>
              <li>
                <strong>Ordinary self-custody</strong> gives you the keys but also all
                of the risk. One leaked phrase or one malicious signature is final.
              </li>
            </ul>
            <p>
              ANTARA takes a third path. You stay fully non-custodial, and a second,
              independent signer enforces rules that you control. Theft now requires
              defeating several unrelated proofs at the same instant, on your terms.
            </p>
          </section>

          <section id="how-it-works" className="ark-doc-section">
            <h2>How it works</h2>
            <h3>Keys never leave your machine</h3>
            <p>
              ANTARA generates your seed and private keys inside a hardened local process
              and keeps them there. The interface you interact with never sees a raw
              key. When something needs signing, the request is handed to that process,
              which signs and returns only the signature.
            </p>
            <h3>A two-of-two vault</h3>
            <p>
              Your funds live in a smart-contract vault that requires two signatures
              to move: yours, and the ANTARA co-signer. Your wallet is one owner. The
              co-signer is the second. Neither party can move funds alone, and the
              co-signer never holds your keys.
            </p>
            <h3>The policy engine</h3>
            <p>
              Before the co-signer adds its signature, it checks the request against
              the policy you set when you created the vault. Each enabled layer is a
              condition that must pass. If any required proof is missing or fails, the
              co-signer simply does not sign and the transfer cannot execute.
            </p>
            <Callout title="What this prevents">
              An attacker who copies your seed phrase still cannot move funds: they
              would also need your face, your hardware key, your trusted device, your
              location, or your voice, exactly as your policy demands.
            </Callout>
          </section>

          <section id="security-layers" className="ark-doc-section">
            <h2>Security layers</h2>
            <p>
              At vault creation you choose which layers to enable. Each one is a
              separate proof the co-signer enforces. Turn on as few or as many as you
              want.
            </p>
            <div className="ark-doc-grid">
              <div className="ark-doc-card">
                <h4>Biometrics</h4>
                <p>
                  Your face or fingerprint, verified through the operating system and
                  hardware passkeys. Cross-device, so you can approve from your phone.
                </p>
              </div>
              <div className="ark-doc-card">
                <h4>USB key</h4>
                <p>
                  A physical security key you hold. If it is not plugged in, the vault
                  cannot sign. Possession is required, not just knowledge.
                </p>
              </div>
              <div className="ark-doc-card">
                <h4>Bluetooth</h4>
                <p>
                  Binds approvals to a trusted device that has to be near you. Walk
                  away and approvals stop.
                </p>
              </div>
              <div className="ark-doc-card">
                <h4>Geolocation</h4>
                <p>
                  Restricts transfers to places you approve. A request from anywhere
                  else is denied by default.
                </p>
              </div>
              <div className="ark-doc-card">
                <h4>Voice</h4>
                <p>
                  A voiceprint check as a final spoken confirmation before a transfer
                  is cleared.
                </p>
              </div>
            </div>
            <Callout title="Changing layers later">
              Layers can be edited after setup, but turning one off requires passing
              the policy that is currently active. To disable a layer you must satisfy
              it first, so an attacker cannot quietly strip your protections.
            </Callout>
          </section>

          <section id="getting-started" className="ark-doc-section">
            <h2>Getting started</h2>
            <ol className="ark-doc-steps">
              <li>
                <strong>Install ANTARA.</strong> Download the desktop app and run the
                installer for your platform.
              </li>
              <li>
                <strong>Create a vault.</strong> Set a strong password. It encrypts the
                local key store on your machine.
              </li>
              <li>
                <strong>Save your recovery phrase.</strong> ANTARA shows your seed phrase
                once. Write it down and store it offline. It is the only way to restore
                your wallet on a new device.
              </li>
              <li>
                <strong>Choose your security layers.</strong> Enable the proofs you want
                the co-signer to enforce, and enroll each one.
              </li>
              <li>
                <strong>Fund your vault.</strong> Send assets to your vault address and
                you are ready to transact.
              </li>
            </ol>
            <Callout title="Your password is not your keys">
              The password unlocks the local key store. It is not your seed phrase and
              it cannot recover your wallet on its own. Keep the recovery phrase safe
              and separate.
            </Callout>
          </section>

          <section id="using-ark" className="ark-doc-section">
            <h2>Using ANTARA</h2>
            <h3>Sending and approvals</h3>
            <p>
              When you send funds, your wallet signs first, then the request goes to
              the co-signer. The co-signer runs your policy, prompts for any proofs it
              needs, and only then adds the second signature so the transfer can
              execute on-chain.
            </p>
            <h3>Swaps</h3>
            <p>
              ANTARA swaps run through Uniswap using the Universal Router and{" "}
              <Code>Permit2</Code>. Quotes and the swap transaction are built for you,
              and the signing happens in the same protected local process. The same
              co-signing policy applies to swaps as to transfers.
            </p>
            <h3>Managing wallets</h3>
            <p>
              You can hold multiple wallets, label them, and switch between them from
              the side panel. Each is derived from your single recovery phrase.
            </p>
            <h3>Editing your policy</h3>
            <p>
              Open settings to toggle layers on or off. Remember that disabling a
              layer requires passing the current policy first.
            </p>
          </section>

          <section id="recovery" className="ark-doc-section">
            <h2>Backup and recovery</h2>
            <p>
              Your recovery phrase is the master backup. With it you can restore your
              wallet on a new machine, even if your old device is lost or destroyed.
            </p>
            <ul className="ark-doc-list">
              <li>Store the phrase offline, never as a photo or a cloud note.</li>
              <li>
                Anyone with the phrase controls the wallet keys, so treat it like the
                keys themselves.
              </li>
              <li>
                Restoring re-derives your wallets. You then re-enroll the security
                layers on the new device.
              </li>
            </ul>
            <Callout title="Layers and recovery">
              Security layers protect day-to-day approvals through the co-signer. They
              are not a substitute for your recovery phrase, and your recovery phrase
              is not a way around the layers on an active vault.
            </Callout>
          </section>

          <section id="threat-model" className="ark-doc-section">
            <h2>Threat model</h2>
            <p>ANTARA is designed to keep you safe against:</p>
            <ul className="ark-doc-list">
              <li>A leaked or stolen seed phrase used on another device.</li>
              <li>Malware on your machine attempting silent, unattended signing.</li>
              <li>Phishing that tricks you into approving a malicious transaction.</li>
              <li>A remote attacker who has everything except physical presence.</li>
            </ul>
            <p>What ANTARA assumes and does not promise:</p>
            <ul className="ark-doc-list">
              <li>
                You must keep your recovery phrase safe. If it leaks and your layers
                are not enabled, standard self-custody risk applies.
              </li>
              <li>
                Layers are only as strong as the hardware and sensors behind them.
                Enabling several unrelated layers raises the bar significantly.
              </li>
              <li>
                ANTARA is non-custodial. No one, including ANTARA, can recover or move funds
                on your behalf.
              </li>
            </ul>
          </section>

          <section id="faq" className="ark-doc-section">
            <h2>FAQ</h2>
            <h4>Is ANTARA custodial?</h4>
            <p>
              No. You hold your keys on your own machine. The co-signer enforces your
              rules but never has custody of your funds.
            </p>
            <h4>Can ANTARA move my funds?</h4>
            <p>
              No. Moving funds always requires your signature first. The co-signer can
              only ever add a second signature, and only when your policy passes.
            </p>
            <h4>What if I lose a security device?</h4>
            <p>
              Use your other enabled layers to approve, then update your policy. If you
              lose access entirely, your recovery phrase restores the wallet on a new
              device.
            </p>
            <h4>Which networks are supported?</h4>
            <p>
              This legacy workspace runs on Base and Ethereum, with swaps routed through
              Uniswap. Polygon is no longer supported. The ANTARA wallet supports Solana,
              Ethereum, BNB Smart Chain, Robinhood Chain and Base.
            </p>
          </section>

          <footer className="ark-doc-footer">
            <span>ANTARA</span>
            <button type="button" onClick={() => openExternal(X_PROFILE_URL)}>
              <XIcon size={15} /> @usearkwallet
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
