import { useEffect, useState, type ReactNode } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseEther, isAddress, type Hex } from "viem";
import {
  getCosigner,
  predictVault,
  buildVaultDeployment,
  setVaultPolicy,
  getVaultDeployed,
  getPortfolio,
  getHistory,
  formatUsd,
  API_BASE,
  type Transfer,
} from "../lib/api";
import { signAndBroadcast, waitForReceipt } from "../lib/swap";
import { type DerivedWallet } from "../lib/wallet";
import { AgentIcon } from "../components/Icons";
import { byKey } from "../solares/networks";
import {
  listAgents,
  addAgent,
  removeAgent,
  type AgentRecord,
} from "../lib/agentStore";

/**
 * Agents — a policy-gated vault for an AI agent. List view shows each agent and
 * its movements; the setup is a two-pane flow (controls + a live summary).
 */

const CHAIN = "base" as const;
type Tab = "agents" | "new" | "skill";

export function Agents({ wallet }: { wallet: DerivedWallet }) {
  const [agents, setAgents] = useState<AgentRecord[]>(() => listAgents());
  const [tab, setTab] = useState<Tab>(agents.length ? "agents" : "new");
  const refresh = () => setAgents(listAgents());

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="mt-1 text-sm text-muted">
            Vaults for AI agents. The agent spends within a policy ANTARA's co-signer
            enforces — it can never exceed your limits.
          </p>
        </div>
        {tab !== "new" && (
          <button
            onClick={() => setTab("new")}
            className="rounded-pill bg-accent px-5 py-2.5 text-sm font-semibold text-base transition-transform hover:scale-[1.02] active:scale-95"
          >
            + New agent
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-6 border-b border-border">
        {(
          [
            ["agents", "Your agents"],
            ["new", "New agent"],
            ["skill", "Skill"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 pb-3 text-sm font-semibold transition-colors ${
              tab === id
                ? "border-accent text-fg"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "agents" && (
          <AgentsList agents={agents} onChanged={refresh} onCreate={() => setTab("new")} />
        )}
        {tab === "new" && (
          <CreateAgent
            wallet={wallet}
            index={agents.length + 1}
            onCreated={() => {
              refresh();
              setTab("agents");
            }}
          />
        )}
        {tab === "skill" && <SkillTab />}
      </div>
    </div>
  );
}

/* ---------------- Your agents + activity ---------------- */

function AgentsList({
  agents,
  onChanged,
  onCreate,
}: {
  agents: AgentRecord[];
  onChanged: () => void;
  onCreate: () => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border py-20 text-center">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl text-base"
          style={{ background: "linear-gradient(135deg,#f4c861,#b07b2c)" }}
        >
          <AgentIcon size={26} />
        </div>
        <p className="mt-4 font-semibold">No agents yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          Create a vault an AI agent can spend from — within limits you control.
        </p>
        <button
          onClick={onCreate}
          className="mt-5 rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base"
        >
          + New agent
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} onRemove={() => { removeAgent(a.id); onChanged(); }} />
      ))}
    </div>
  );
}

function AgentCard({ agent, onRemove }: { agent: AgentRecord; onRemove: () => void }) {
  const [usd, setUsd] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [moves, setMoves] = useState<Transfer[] | null>(null);
  const [loadingMoves, setLoadingMoves] = useState(false);

  useEffect(() => {
    let on = true;
    getPortfolio(agent.vaultAddress)
      .then((p) => on && setUsd(p.totalUsd))
      .catch(() => on && setUsd(null));
    return () => {
      on = false;
    };
  }, [agent.vaultAddress]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && moves == null) {
      setLoadingMoves(true);
      try {
        const { transfers } = await getHistory(agent.vaultAddress);
        setMoves(transfers.filter((t) => t.chain === CHAIN));
      } catch {
        setMoves([]);
      } finally {
        setLoadingMoves(false);
      }
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-4 px-5 py-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#f4c861] to-[#b07b2c] text-base">
          <AgentIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold">{agent.label}</p>
            {agent.deployed === false && (
              <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-muted">
                Not deployed
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted">{agent.vaultAddress}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{usd != null ? formatUsd(usd) : "—"}</p>
          <p className="text-xs text-muted">Base</p>
        </div>
        <button
          onClick={toggle}
          className="ml-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          title="Movements"
        >
          {open ? "▴" : "▾"}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-base px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Movements
            </span>
            <div className="flex items-center gap-3">
              <a
                href={`${byKey("base").explorer.address}${agent.vaultAddress}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent underline"
              >
                Explorer
              </a>
              <button onClick={onRemove} className="text-xs text-muted hover:text-pink">
                Remove
              </button>
            </div>
          </div>
          {loadingMoves ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : moves && moves.length > 0 ? (
            <div className="space-y-1.5">
              {moves.map((t, i) => (
                <a
                  key={`${t.hash}-${i}`}
                  href={`${byKey("base").explorer.tx}${t.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                        t.direction === "in"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-surface-2 text-muted"
                      }`}
                    >
                      {t.direction === "in" ? "↓" : "↑"}
                    </span>
                    {t.direction === "in" ? "Received" : "Sent"}
                  </span>
                  <span className="text-muted">
                    {t.value != null ? trim(String(t.value)) : ""} {t.asset ?? "ETH"}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No movements yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- New agent (two-pane setup) ---------------- */

function CreateAgent({
  wallet,
  index,
  onCreated,
}: {
  wallet: DerivedWallet;
  index: number;
  onCreated: () => void;
}) {
  const [agentKey, setAgentKey] = useState<Hex | null>(null);
  const [agentAddr, setAgentAddr] = useState<`0x${string}` | null>(null);
  const [vaultAddr, setVaultAddr] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [deployHash, setDeployHash] = useState<string | null>(null);

  const [maxEth, setMaxEth] = useState("0.05");
  const [allowlist, setAllowlist] = useState("");
  const [policySaved, setPolicySaved] = useState(false);

  async function createAgent() {
    setError("");
    setBusy("create");
    try {
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      const cs = await getCosigner();
      if (!cs.enabled || !cs.address) throw new Error("ANTARA co-signer unavailable.");
      const { address } = await predictVault({
        chain: CHAIN,
        owners: [acct.address, cs.address],
        threshold: 2,
      });
      const dep = (await getVaultDeployed(CHAIN, address)).deployed;
      setAgentKey(pk);
      setAgentAddr(acct.address);
      setVaultAddr(address);
      setDeployed(dep);
      // Persist immediately (public info only) so it survives a lock/relaunch.
      addAgent({
        label: `Agent ${index}`,
        agentAddress: acct.address,
        vaultAddress: address,
        chain: CHAIN,
        deployed: dep,
      });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy("");
    }
  }

  async function deploy() {
    if (!agentAddr) return;
    setError("");
    setBusy("deploy");
    try {
      const cs = await getCosigner();
      if (!cs.address) throw new Error("ANTARA co-signer unavailable.");
      const dep = await buildVaultDeployment({ chain: CHAIN, owners: [agentAddr, cs.address], threshold: 2 });
      const hash = await signAndBroadcast(CHAIN, wallet.index, wallet.address, dep.to, BigInt(dep.value), dep.data);
      const status = await waitForReceipt(CHAIN, hash);
      if (status !== "success") throw new Error("Deployment reverted on-chain.");
      setDeployHash(hash);
      setDeployed(true);
      if (agentAddr && vaultAddr) {
        addAgent({
          label: `Agent ${index}`,
          agentAddress: agentAddr,
          vaultAddress: vaultAddr,
          chain: CHAIN,
          deployed: true,
        });
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy("");
    }
  }

  async function savePolicy() {
    if (!vaultAddr) return;
    setError("");
    setBusy("policy");
    setPolicySaved(false);
    try {
      const list = allowlist
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => isAddress(s)) as `0x${string}`[];
      await setVaultPolicy({
        chain: CHAIN,
        safeAddress: vaultAddr,
        config: {
          maxValueWei: maxEth && Number(maxEth) > 0 ? parseEther(maxEth).toString() : undefined,
          allowlist: list.length ? list : undefined,
        },
      });
      setPolicySaved(true);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy("");
    }
  }

  const started = !!agentKey;
  const mcpConfig = `{
  "mcpServers": {
    "ark": {
      "command": "node",
      "args": ["/path/to/solares-agent-mcp/dist/index.js"],
      "env": {
        "ARK_AGENT_PRIVATE_KEY": "${agentKey ?? "0x..."}",
        "ARK_CHAIN": "${CHAIN}",
        "ARK_API_BASE": "${API_BASE}"
      }
    }
  }
}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* LEFT — controls */}
      <div className="overflow-hidden rounded-3xl border border-border bg-surface">
        {error && (
          <p className="border-b border-red-500/30 bg-red-500/10 px-6 py-3 text-sm text-red-400">{error}</p>
        )}

        <Section step={1} title="Create the agent's identity" done={started}>
          {!started ? (
            <button
              onClick={createAgent}
              disabled={busy === "create"}
              className="rounded-pill bg-accent px-6 py-2.5 text-sm font-semibold text-base disabled:opacity-50"
            >
              {busy === "create" ? "Generating…" : "Generate agent key"}
            </button>
          ) : (
            <p className="text-sm text-muted">
              A fresh key was generated — see it in the panel on the right and save it now.
            </p>
          )}
        </Section>

        <Section step={2} title="Deploy and fund" done={deployed} disabled={!started}>
          <p className="text-sm text-muted">
            Deploy the 2-of-2 vault on Base (gas from your wallet), then send it ETH.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={deploy}
              disabled={!started || deployed || busy === "deploy"}
              className="rounded-pill bg-accent px-6 py-2.5 text-sm font-semibold text-base disabled:opacity-50"
            >
              {deployed ? "Deployed" : busy === "deploy" ? "Deploying…" : "Deploy vault"}
            </button>
            {deployHash && (
              <a
                href={`${byKey("base").explorer.tx}${deployHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent underline"
              >
                View tx
              </a>
            )}
          </div>
        </Section>

        <Section step={3} title="Set the spending policy" done={policySaved} disabled={!started}>
          <p className="text-sm text-muted">
            Enforced on every agent transaction. Always set a cap.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[160px_1fr]">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Max / tx (ETH)
              </label>
              <input
                value={maxEth}
                onChange={(e) => setMaxEth(e.target.value.replace(/[^0-9.]/g, ""))}
                className="mt-1 w-full rounded-xl border border-border bg-base px-4 py-2.5 text-sm outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Allowlist (optional)
              </label>
              <input
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                spellCheck={false}
                placeholder="0xabc…, 0xdef…  (empty = any)"
                className="mt-1 w-full rounded-xl border border-border bg-base px-4 py-2.5 font-mono text-xs outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={savePolicy}
              disabled={!vaultAddr || busy === "policy"}
              className="rounded-pill bg-accent px-6 py-2.5 text-sm font-semibold text-base disabled:opacity-50"
            >
              {busy === "policy" ? "Saving…" : "Save policy"}
            </button>
            {policySaved && <span className="text-xs font-semibold text-emerald-400">Saved</span>}
          </div>
        </Section>
      </div>

      {/* RIGHT — live summary */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-3xl border border-border bg-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">This agent</p>

          {!started ? (
            <p className="mt-3 text-sm text-muted">
              Generate a key to begin. The agent's identity, vault, and connection
              config will appear here.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              <Mini label="Agent private key" value={agentKey!} danger />
              <Mini label="Agent address" value={agentAddr!} />
              <Mini label="Vault address" value={vaultAddr!} />

              <div className="flex flex-wrap gap-2 pt-1">
                <Pill on={deployed}>{deployed ? "Deployed" : "Not deployed"}</Pill>
                <Pill on={policySaved}>{policySaved ? "Policy set" : "No policy"}</Pill>
              </div>

              <div>
                <p className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  MCP config
                </p>
                <CodeBlock text={mcpConfig} />
              </div>

              <button
                onClick={onCreated}
                className="mt-1 w-full rounded-pill bg-accent px-6 py-2.5 text-sm font-semibold text-base"
              >
                Done — view in Your agents
              </button>
              <p className="rounded-xl border border-pink/30 bg-pink/10 px-3 py-2 text-[11px] leading-relaxed text-pink">
                Save the agent key into the MCP config now. It is shown once and
                never stored. Lose it and the vault's funds cannot be moved (it
                takes both the agent key and the co-signer).
              </p>
              <p className="text-[11px] leading-relaxed text-muted">
                This agent is already saved under Your agents (public address
                only). It will still be there after you lock and reopen.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ---------------- Skill ---------------- */

const SKILL_MD = `---
name: ark-vault
description: Manage an ANTARA agent vault — read balance and policy, and make payments or swaps that ANTARA's co-signer approves only within the owner's limits. Requires the ANTARA MCP server (ark_status, ark_balance, ark_pay, ark_swap).
---

# ANTARA Vault

You have an ANTARA vault: an on-chain treasury where every payment is checked
against a spending policy the owner set. You cannot exceed it, by design.

## Before spending
1. Call ark_status to read your vault and policy (per-tx cap, allowlist).
2. Call ark_balance to confirm funds.

## Paying / swapping
- ark_pay { to, amount, token? } and ark_swap { tokenOut, amount }.
- Stay within the cap and allowlist. If DENIED, do not retry or split to evade —
  report the reason to the owner.

## Safety
- Never handle or reveal the private key. Double-check recipients. Treat the
  policy as the owner's intent and operate within it, never around it.`;

function SkillTab() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-3xl border border-border bg-surface">
        <Section step={1} title="Install the ANTARA skill" done={false}>
          <p className="text-sm text-muted">
            Save the file as{" "}
            <span className="font-mono text-fg">.claude/skills/ark-vault/SKILL.md</span>{" "}
            in your agent's project (or under{" "}
            <span className="font-mono text-fg">~/.claude/skills/</span> to make it
            global). Grab it any time at{" "}
            <span className="font-mono text-fg">useark.app/skill.md</span>, or copy
            it below.
          </p>
          <div className="mt-4">
            <CodeBlock text={SKILL_MD} label="SKILL.md" />
          </div>
        </Section>
        <Section step={2} title="Pair with the MCP server" done={false}>
          <p className="text-sm text-muted">
            Connect the ANTARA MCP server (New agent, step on the right). The skill
            uses its tools: <Code>ark_status</Code>, <Code>ark_balance</Code>,{" "}
            <Code>ark_pay</Code>, <Code>ark_swap</Code>.
          </p>
        </Section>
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-3xl border border-border bg-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Why a skill</p>
          <p className="mt-3 text-sm text-muted">
            The MCP server gives the agent the tools. The skill gives it the
            judgment: read the policy first, stay within limits, and handle a
            refusal without trying to route around it. Together they make an agent
            that manages its vault responsibly out of the box.
          </p>
        </div>
      </aside>
    </div>
  );
}

/* ---------------- shared bits ---------------- */

function Section({
  step,
  title,
  children,
  done,
  disabled,
}: {
  step: number;
  title: string;
  children: ReactNode;
  done?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`border-b border-border px-6 py-5 last:border-b-0 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
            done ? "bg-emerald-500 text-base" : "bg-accent text-base"
          }`}
        >
          {done ? "✓" : step}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <div className="mt-3 pl-9">{children}</div>
    </div>
  );
}

function Mini({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={`text-[11px] ${danger ? "font-semibold text-pink" : "text-muted"}`}>{label}</p>
        <button onClick={copy} className="text-[11px] font-semibold text-accent">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-0.5 break-all font-mono text-xs">{value}</p>
    </div>
  );
}

function Pill({ on, children }: { on?: boolean; children: ReactNode }) {
  return (
    <span
      className={`rounded-pill px-2.5 py-1 text-[11px] font-semibold ${
        on ? "bg-emerald-500/15 text-emerald-400" : "bg-surface-2 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{children}</span>;
}

function CodeBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-base">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-muted">{label ?? "config"}</span>
        <button onClick={copy} className="text-[11px] font-semibold text-accent">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2.5 text-[11px] leading-relaxed">{text}</pre>
    </div>
  );
}

function trim(s: string): string {
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
