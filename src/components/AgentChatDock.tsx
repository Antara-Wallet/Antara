import { useEffect, useRef, useState } from "react";
import { type Hex } from "viem";
import {
  getAgentGate,
  agentChatCall,
  getPortfolio,
  getVaultPolicy,
  type AgentGate,
  type ChatBlock,
} from "../lib/api";
import { byoChat, AgentSession, PolicyDenied } from "../lib/agentChatClient";
import { listAgents, type AgentRecord } from "../lib/agentStore";
import { type DerivedWallet } from "../lib/wallet";
import { SettingsIcon } from "./Icons";

/**
 * Global agent chat dock — collapsed to a pill bottom-right (like the swap rail),
 * expands into a drop-up chat. Switch agents up top, open settings (cog) to pick
 * hosted ($ARK-gated) or bring-your-own-key, and unlock spending with the agent
 * key (session-only). Spends sign client-side and pass the co-signer policy.
 */

type Mode = "hosted" | "byo";
type ApiMsg = { role: "user" | "assistant"; content: unknown };

const lsGet = (k: string, d = "") => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};

export function AgentChatDock({ wallet }: { wallet: DerivedWallet }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentId, setAgentId] = useState("");
  const agent = agents.find((a) => a.id === agentId);

  const [mode, setMode] = useState<Mode>((lsGet("ark.chat.mode", "hosted") as Mode) || "hosted");
  const [byoKey, setByoKey] = useState(lsGet("ark.chat.byokey"));
  const [settings, setSettings] = useState(false);

  const [gate, setGate] = useState<AgentGate | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [spendKey, setSpendKey] = useState("");

  const [msgs, setMsgs] = useState<ApiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const confirmRes = useRef<((ok: boolean) => void) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Load deployed agents whenever the dock opens.
  useEffect(() => {
    if (!open) return;
    const list = listAgents().filter((a) => a.deployed);
    setAgents(list);
    setAgentId((id) => (list.some((a) => a.id === id) ? id : list[0]?.id ?? ""));
  }, [open]);

  useEffect(() => {
    if (mode !== "hosted") return;
    getAgentGate(wallet.address).then(setGate).catch(() => setGate(null));
  }, [wallet.address, mode]);

  useEffect(() => {
    setSession(null);
    setMsgs([]);
  }, [agentId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs, pending]);

  function persistMode(m: Mode) {
    setMode(m);
    try { localStorage.setItem("ark.chat.mode", m); } catch { /* ignore */ }
  }
  function saveByoKey() {
    try { localStorage.setItem("ark.chat.byokey", byoKey.trim()); } catch { /* ignore */ }
    setSettings(false);
  }
  function unlockSpending() {
    if (!agent) return;
    try {
      setSession(new AgentSession(spendKey.trim() as Hex, "base", agent.vaultAddress));
      setSpendKey("");
      setError("");
    } catch {
      setError("That doesn't look like a valid agent key.");
    }
  }

  function askConfirm(summary: string): Promise<boolean> {
    setPending(summary);
    return new Promise((res) => (confirmRes.current = res));
  }
  function resolveConfirm(ok: boolean) {
    setPending(null);
    const r = confirmRes.current;
    confirmRes.current = null;
    r?.(ok);
  }

  async function executeTool(tu: ChatBlock): Promise<string> {
    if (!agent) return "No agent selected.";
    const inp = (tu.input ?? {}) as Record<string, string>;
    try {
      if (tu.name === "get_balance") {
        const pf = await getPortfolio(agent.vaultAddress);
        return JSON.stringify({
          totalUsd: pf.totalUsd,
          tokens: pf.tokens.filter((t) => t.chain === "base").map((t) => ({ symbol: t.symbol, balance: t.balance })),
        });
      }
      if (tu.name === "get_policy") {
        const { config } = await getVaultPolicy("base", agent.vaultAddress);
        return JSON.stringify(config);
      }
      if (tu.name === "pay" || tu.name === "swap") {
        if (!session) return "Spending is locked: the owner has not unlocked it (no agent key provided).";
        const summary =
          tu.name === "pay"
            ? `Pay ${inp.amount} ${inp.token ?? "ETH"} to ${inp.to}`
            : `Swap ${inp.amount} ETH for token ${inp.tokenOut}`;
        if (!(await askConfirm(summary))) return "The owner declined this action.";
        const res =
          tu.name === "pay"
            ? await session.pay({ to: inp.to, amount: inp.amount, token: inp.token })
            : await session.swap({ tokenOut: inp.tokenOut, amount: inp.amount });
        return `Executed. Transaction ${res.hash} (${res.status}).`;
      }
      return "Unknown tool.";
    } catch (e) {
      if (e instanceof PolicyDenied) return e.message;
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function runTurn(history: ApiMsg[]) {
    const resp =
      mode === "byo"
        ? await byoChat(byoKey, { vaultAddress: agent!.vaultAddress, messages: history })
        : await agentChatCall({ ownerAddress: wallet.address, vaultAddress: agent!.vaultAddress, messages: history });
    let next: ApiMsg[] = [...history, { role: "assistant", content: resp.content }];
    setMsgs(next);
    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (resp.stop_reason === "tool_use" && toolUses.length) {
      const results = [];
      for (const tu of toolUses) results.push({ type: "tool_result", tool_use_id: tu.id, content: await executeTool(tu) });
      next = [...next, { role: "user", content: results }];
      setMsgs(next);
      await runTurn(next);
    }
  }

  async function send() {
    if (!input.trim() || busy || !agent) return;
    setError("");
    const next: ApiMsg[] = [...msgs, { role: "user", content: input.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      await runTurn(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const locked = mode === "hosted" ? !!gate && !gate.ok : !byoKey.trim();
  const lockMsg =
    mode === "hosted"
      ? `Hold $${gate?.requiredUsd ?? 50} of $ARK to use the hosted agent.`
      : "Add your API key in settings to chat.";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask your agent"
        className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 items-center rounded-l-xl bg-accent py-6 pl-1.5 pr-2 text-base shadow-lg transition-[padding] hover:pl-3"
      >
        <span className="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold uppercase tracking-wide">
          Agent
        </span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex h-[540px] w-[380px] flex-col overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl">
      {/* Header: agent switch + settings + minimize */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {agents.length > 0 ? (
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-base px-3 py-1.5 text-sm outline-none"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1 text-sm text-muted">No deployed agents</span>
        )}
        <button
          onClick={() => setSettings((s) => !s)}
          title="Settings"
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 ${settings ? "text-accent" : "text-muted hover:text-fg"}`}
        >
          <SettingsIcon size={18} />
        </button>
        <button
          onClick={() => setOpen(false)}
          title="Minimize"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          ▾
        </button>
      </div>

      {settings ? (
        <SettingsPanel
          mode={mode}
          onMode={persistMode}
          gate={gate}
          byoKey={byoKey}
          setByoKey={setByoKey}
          onSaveByo={saveByoKey}
          session={session}
          spendKey={spendKey}
          setSpendKey={setSpendKey}
          onUnlock={unlockSpending}
          hasAgent={!!agent}
        />
      ) : (
        <>
          <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {!agent ? (
              <p className="text-sm text-muted">Deploy an agent in the Agents tab, then talk to it here.</p>
            ) : msgs.length === 0 ? (
              <p className="text-sm text-muted">
                Ask about balance or policy, or tell it to pay or swap. It only acts within your policy, and you approve every transaction.
              </p>
            ) : (
              msgs.map((m, i) => <Bubble key={i} msg={m} />)
            )}
            {busy && <p className="text-xs text-muted">Thinking…</p>}
            {pending && (
              <div className="rounded-2xl border border-accent/40 bg-accent/10 p-3">
                <p className="text-sm font-semibold">Approve this action?</p>
                <p className="mt-1 text-sm text-muted">{pending}</p>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => resolveConfirm(false)} className="flex-1 rounded-pill border border-border bg-surface px-3 py-1.5 text-sm font-semibold">
                    Decline
                  </button>
                  <button onClick={() => resolveConfirm(true)} className="flex-1 rounded-pill bg-accent px-3 py-1.5 text-sm font-semibold text-base">
                    Approve
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && <p className="border-t border-border px-3 py-1.5 text-xs text-pink">{error}</p>}
          {locked && agent && (
            <button
              onClick={() => setSettings(true)}
              className="border-t border-border px-3 py-2 text-left text-xs text-muted hover:text-fg"
            >
              {lockMsg} Open settings →
            </button>
          )}

          <div className="border-t border-border p-2.5">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && !locked && agent && send()}
                disabled={busy || locked || !agent}
                placeholder={!agent ? "No agent" : locked ? "Locked" : "Message your agent…"}
                className="flex-1 rounded-pill border border-border bg-base px-3.5 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
              />
              <button
                onClick={send}
                disabled={busy || locked || !agent || !input.trim()}
                className="rounded-pill bg-accent px-4 py-2 text-sm font-semibold text-base disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SettingsPanel({
  mode,
  onMode,
  gate,
  byoKey,
  setByoKey,
  onSaveByo,
  session,
  spendKey,
  setSpendKey,
  onUnlock,
  hasAgent,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  gate: AgentGate | null;
  byoKey: string;
  setByoKey: (s: string) => void;
  onSaveByo: () => void;
  session: AgentSession | null;
  spendKey: string;
  setSpendKey: (s: string) => void;
  onUnlock: () => void;
  hasAgent: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Brain</p>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-2xl bg-base p-1">
          {(["hosted", "byo"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => onMode(m)}
              className={`rounded-xl py-1.5 text-xs font-semibold transition-colors ${mode === m ? "bg-accent text-base" : "text-muted hover:text-fg"}`}
            >
              {m === "hosted" ? "ANTARA hosted" : "Your own key"}
            </button>
          ))}
        </div>

        {mode === "hosted" ? (
          <div className="mt-3 text-sm">
            {gate == null ? (
              <p className="text-muted">Checking $ARK balance…</p>
            ) : gate.ok ? (
              <p className="text-emerald-400">Unlocked — you hold ${gate.usd.toFixed(2)} of $ARK.</p>
            ) : (
              <p className="text-muted">
                Hold ${gate.requiredUsd} of $ARK to use ANTARA's hosted model. You have ${gate.usd.toFixed(2)}.{" "}
                <a href={`https://dexscreener.com/base/${gate.token}`} target="_blank" rel="noreferrer" className="font-semibold text-accent underline">
                  Get $ARK
                </a>
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-xs text-muted">
              Use your own Anthropic key (kept on this device, sent only to Anthropic). No $ARK needed.
            </p>
            <input
              type="password"
              value={byoKey}
              onChange={(e) => setByoKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-2 w-full rounded-xl border border-border bg-base px-3 py-2 font-mono text-xs outline-none focus:border-accent"
            />
            <button onClick={onSaveByo} disabled={!byoKey.trim()} className="mt-2 w-full rounded-pill bg-accent px-4 py-2 text-sm font-semibold text-base disabled:opacity-50">
              Save key
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Spending</p>
        {session ? (
          <p className="mt-2 text-sm text-emerald-400">Unlocked for this session.</p>
        ) : (
          <div className="mt-2">
            <p className="text-xs text-muted">
              Read-only until you paste this agent's key (held only for this session, never stored or sent).
            </p>
            <input
              type="password"
              value={spendKey}
              onChange={(e) => setSpendKey(e.target.value)}
              disabled={!hasAgent}
              placeholder="Agent private key (0x…)"
              className="mt-2 w-full rounded-xl border border-border bg-base px-3 py-2 font-mono text-xs outline-none focus:border-accent disabled:opacity-50"
            />
            <button onClick={onUnlock} disabled={!hasAgent || !spendKey.trim()} className="mt-2 w-full rounded-pill bg-accent px-4 py-2 text-sm font-semibold text-base disabled:opacity-50">
              Unlock spending
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ApiMsg }) {
  if (msg.role === "user" && typeof msg.content === "string") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm text-base">{msg.content}</div>
      </div>
    );
  }
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    return (
      <div className="space-y-2">
        {(msg.content as ChatBlock[]).map((b, i) => {
          if (b.type === "text" && b.text)
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl border border-border bg-base px-3 py-2 text-sm">{b.text}</div>
              </div>
            );
          if (b.type === "tool_use")
            return (
              <p key={i} className="text-xs text-muted">
                → {b.name}({Object.values(b.input ?? {}).join(", ")})
              </p>
            );
          return null;
        })}
      </div>
    );
  }
  return null;
}
