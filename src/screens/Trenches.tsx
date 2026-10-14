import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseEther, type Hex } from "viem";
import {
  getTrenches,
  formatCompactUsd,
  formatAge,
  type TrenchChain,
  type TrenchToken,
  type Trenches as TrenchData,
} from "../lib/api";
import { executeSwap, type SwapPhase } from "../lib/swap";
import { openUrl } from "@tauri-apps/plugin-opener";

const POLL_MS = 5000;

// Market-cap buckets for the two right-hand panels.
const BOND_MIN = 20_000;
const BOND_MAX = 70_000;

type PanelKey = "new" | "bonding" | "migrated";
const PANELS: { key: PanelKey; label: string }[] = [
  { key: "new", label: "New" },
  { key: "bonding", label: "Almost bonded" },
  { key: "migrated", label: "Migrated" },
];

type SortKey = "new" | "old" | "mc" | "vol" | "holders";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "new", label: "Newest" },
  { key: "old", label: "Oldest" },
  { key: "mc", label: "Market cap" },
  { key: "vol", label: "Volume" },
  { key: "holders", label: "Holders" },
];

function sortTokens(list: TrenchToken[], key: SortKey): TrenchToken[] {
  const n = (v: number | null, d: number) => (v == null ? d : v);
  const cmp: Record<SortKey, (a: TrenchToken, b: TrenchToken) => number> = {
    new: (a, b) => n(a.ageSeconds, Infinity) - n(b.ageSeconds, Infinity),
    old: (a, b) => n(b.ageSeconds, -1) - n(a.ageSeconds, -1),
    mc: (a, b) => n(b.marketCap, 0) - n(a.marketCap, 0),
    vol: (a, b) => n(b.volume, 0) - n(a.volume, 0),
    holders: (a, b) => n(b.holderCount, 0) - n(a.holderCount, 0),
  };
  return [...list].sort(cmp[key]);
}

export interface SniperCfg {
  enabled: boolean;
  amountEth: string;
  slippageBps: number;
}
const SNIPER_KEY = "ark.sniper";
const SNIPER_DEFAULT: SniperCfg = { enabled: false, amountEth: "0.05", slippageBps: 100 };
function getSniper(): SniperCfg {
  try {
    const r = localStorage.getItem(SNIPER_KEY);
    if (r) return { ...SNIPER_DEFAULT, ...(JSON.parse(r) as Partial<SniperCfg>) };
  } catch {
    /* ignore */
  }
  return { ...SNIPER_DEFAULT };
}
function saveSniper(c: SniperCfg) {
  try {
    localStorage.setItem(SNIPER_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export function Trenches({
  onBuy,
  wallet,
  readOnly = false,
}: {
  onBuy?: (t: TrenchToken, chain: TrenchChain) => void;
  wallet?: { address: string; index: number };
  readOnly?: boolean;
} = {}) {
  const [data, setData] = useState<TrenchData | null>(null);
  const seenError = useRef(false);
  const [query, setQuery] = useState("");
  const [sorts, setSorts] = useState<Record<PanelKey, SortKey>>({
    new: "new",
    bonding: "new",
    migrated: "new",
  });
  const [sniper, setSniper] = useState<SniperCfg>(getSniper);
  const [sniperOpen, setSniperOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getTrenches("base")
        .then((d) => alive && setData(d))
        .catch(() => {
          if (!alive) return;
          seenError.current = true;
          setData({ new_creation: [], near_completion: [], completed: [] });
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Dedupe every token into one pool so the MC buckets draw from everything.
  const pool = useMemo(() => {
    if (!data) return null;
    const map = new Map<string, TrenchToken>();
    for (const t of [...data.new_creation, ...data.near_completion, ...data.completed]) {
      map.set(t.address.toLowerCase(), t);
    }
    return [...map.values()];
  }, [data]);

  const q = query.trim().toLowerCase();
  const match = (t: TrenchToken) =>
    !q ||
    t.symbol?.toLowerCase().includes(q) ||
    t.name?.toLowerCase().includes(q) ||
    t.address.toLowerCase().includes(q);

  function bucket(key: PanelKey): TrenchToken[] | null {
    if (!data || !pool) return null;
    let list: TrenchToken[];
    if (key === "new") {
      list = data.new_creation.filter(match);
    } else if (key === "bonding") {
      list = pool.filter(
        (t) => t.marketCap != null && t.marketCap >= BOND_MIN && t.marketCap < BOND_MAX
      ).filter(match);
    } else {
      list = pool.filter((t) => t.marketCap != null && t.marketCap >= BOND_MAX).filter(match);
    }
    return sortTokens(list, sorts[key]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, symbol or address"
            spellCheck={false}
            className="w-full rounded-pill border border-border bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>
        {!readOnly && <button
          onClick={() => setSniperOpen(true)}
          className={`ml-auto flex items-center gap-2 rounded-pill border px-4 py-2 text-sm font-semibold transition-colors ${
            sniper.enabled
              ? "border-accent/50 bg-accent/10 text-accent"
              : "border-border bg-surface text-muted hover:text-fg"
          }`}
        >
          <BoltIcon />
          {sniper.enabled ? `Sniper · ${sniper.amountEth} ETH` : "Sniper off"}
        </button>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        {PANELS.map((p) => (
          <Column
            key={p.key}
            label={p.label}
            tokens={bucket(p.key)}
            errored={seenError.current}
            sort={sorts[p.key]}
            onSort={(s) => setSorts((prev) => ({ ...prev, [p.key]: s }))}
            onBuy={onBuy}
            wallet={readOnly ? undefined : wallet}
            sniper={readOnly ? SNIPER_DEFAULT : sniper}
          />
        ))}
      </div>

      {!readOnly && sniperOpen && (
        <SniperSettings
          cfg={sniper}
          onSave={(c) => {
            setSniper(c);
            saveSniper(c);
            setSniperOpen(false);
          }}
          onClose={() => setSniperOpen(false)}
        />
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

function SniperSettings({
  cfg,
  onSave,
  onClose,
}: {
  cfg: SniperCfg;
  onSave: (c: SniperCfg) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [amount, setAmount] = useState(cfg.amountEth);
  const [slippage, setSlippage] = useState(String(cfg.slippageBps / 100));

  function save() {
    const amt = amount.trim() === "" ? "0" : amount.trim();
    const bps = Math.max(10, Math.round((Number(slippage) || 1) * 100));
    onSave({ enabled, amountEth: amt, slippageBps: bps });
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <span className="text-accent"><BoltIcon /></span> Sniper
          </h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">✕</button>
        </div>
        <p className="mt-1 text-xs text-muted">
          One-click buys. With the sniper on, tapping Buy instantly swaps this much
          ETH for the token — no popup.
        </p>

        <label className="mt-5 flex items-center justify-between rounded-2xl border border-border bg-base px-4 py-3">
          <span className="text-sm font-semibold">Enable one-click buy</span>
          <button
            onClick={() => setEnabled((v) => !v)}
            className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${enabled ? "bg-accent" : "bg-surface-2"}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : ""}`} />
          </button>
        </label>

        <label className="mt-4 block text-xs text-muted">Buy amount (ETH)</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="0.05"
          className="mt-1 w-full rounded-xl border border-border bg-base px-3 py-2.5 text-sm outline-none focus:border-accent"
        />

        <label className="mt-4 block text-xs text-muted">Max slippage (%)</label>
        <input
          value={slippage}
          onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="1"
          className="mt-1 w-full rounded-xl border border-border bg-base px-3 py-2.5 text-sm outline-none focus:border-accent"
        />

        <button
          onClick={save}
          className="mt-5 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform hover:scale-[1.01] active:scale-95"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Column({
  label,
  tokens,
  errored,
  sort,
  onSort,
  onBuy,
  wallet,
  sniper,
}: {
  label: string;
  tokens: TrenchToken[] | null;
  errored: boolean;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onBuy?: (t: TrenchToken, chain: TrenchChain) => void;
  wallet?: { address: string; index: number };
  sniper: SniperCfg;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold">{label}</h2>
          <span className="text-xs text-muted">{tokens == null ? "…" : tokens.length}</span>
        </div>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="rounded-md border border-border bg-base px-2 py-1 text-xs text-muted outline-none focus:border-accent"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {tokens == null && <ColumnSkeleton />}
        {tokens != null && tokens.length === 0 && (
          <EmptyColumn errored={errored} />
        )}
        {tokens?.map((t) => (
          <TrenchCard
            key={`${t.chain}:${t.address}`}
            t={t}
            onBuy={onBuy}
            wallet={wallet}
            sniper={sniper}
          />
        ))}
      </div>
    </section>
  );
}

function TrenchCard({
  t,
  onBuy,
  wallet,
  sniper,
}: {
  t: TrenchToken;
  onBuy?: (t: TrenchToken, chain: TrenchChain) => void;
  wallet?: { address: string; index: number };
  sniper: SniperCfg;
}) {
  const [phase, setPhase] = useState<SwapPhase | null>(null);
  const buying = phase != null && phase !== "done" && phase !== "error";

  const canSnipe = sniper.enabled && !!wallet && Number(sniper.amountEth) > 0;

  async function handleBuy() {
    if (buying) return;
    if (canSnipe && wallet) {
      setPhase("quoting");
      try {
        await executeSwap(
          {
            chain: "base",
            accountIndex: wallet.index,
            from: wallet.address as Hex,
            tokenIn: "native",
            tokenOut: t.address,
            amountIn: parseEther(sniper.amountEth).toString(),
            slippageBps: sniper.slippageBps,
          },
          setPhase
        );
      } catch {
        setPhase("error");
      }
      return;
    }
    onBuy?.(t, "base");
  }

  const buyLabel =
    phase === "done"
      ? "Bought"
      : phase === "error"
        ? "Retry"
        : buying
          ? "Buying…"
          : canSnipe
            ? `Buy ${sniper.amountEth}`
            : "Buy";

  return (
    <div className="rounded-xl border border-border bg-base p-3 transition-colors hover:border-muted/40">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <TokenLogo logo={t.logo} symbol={t.symbol} />
          <LaunchpadMark name={t.launchpad} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-bold">{t.symbol}</span>
            <span className="truncate text-xs text-muted">{t.name}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-xs text-muted">{formatAge(t.ageSeconds)}</span>
            <Socials twitter={t.twitter} website={t.website} telegram={t.telegram} />
          </div>
        </div>
        <BuyButton onClick={handleBuy} label={buyLabel} disabled={buying} busy={buying} />
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
        <Stat label="MC" value={formatCompactUsd(t.marketCap)} />
        <Stat label="Vol" value={formatCompactUsd(t.volume)} />
        <Stat
          label="Holders"
          value={t.holderCount != null ? String(t.holderCount) : "—"}
        />
      </div>

      {t.progress != null && t.progress < 1 && <ProgressBar value={t.progress} />}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-semibold">
        <Metric icon={<UsersIcon />} title="Top 10 holders" value={pctLabel(t.top10HolderRate)} tone={rateTone(t.top10HolderRate, 0.3)} />
        <Metric icon={<DevIcon />} title="Dev holdings" value={pctLabel(t.devHoldRate)} tone={rateTone(t.devHoldRate, 0.1)} />
        <Metric icon={<EyeIcon />} title="Insiders" value={pctLabel(t.insiderRate)} tone={rateTone(t.insiderRate, 0.1)} />
        {t.sniperCount != null && (
          <Metric icon={<TargetIcon />} title="Snipers" value={String(t.sniperCount)} tone={t.sniperCount > 3 ? "bad" : t.sniperCount > 0 ? "warn" : "good"} />
        )}
        {t.liquidity != null && (
          <Metric icon={<DropIcon />} title="Liquidity" value={formatCompactUsd(t.liquidity)} tone="muted" />
        )}
        {taxLabel(t.buyTax, t.sellTax) && (
          <Metric icon={<TaxIcon />} title="Buy / sell tax" value={taxLabel(t.buyTax, t.sellTax)!} tone={highTax(t.buyTax, t.sellTax) ? "bad" : "muted"} />
        )}
        {t.smartDegenCount != null && t.smartDegenCount > 0 && (
          <Metric icon={<StarIcon />} title="Smart money" value={String(t.smartDegenCount)} tone="good" />
        )}
        {t.isRenounced === true && (
          <Metric icon={<ShieldCheckIcon />} title="Ownership renounced" value="Renounced" tone="good" />
        )}
        {t.isHoneypot === true && (
          <Metric icon={<WarnIcon />} title="Honeypot risk" value="Honeypot" tone="bad" />
        )}
      </div>
    </div>
  );
}

function TokenLogo({ logo, symbol }: { logo: string | null; symbol: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-[11px] font-bold">
      {logo ? (
        <img src={logo} alt="" className="h-full w-full object-cover" />
      ) : (
        symbol.slice(0, 3).toUpperCase()
      )}
    </span>
  );
}

const LAUNCHPAD_COLOR: Record<string, string> = {
  clanker: "text-mint",
  bankr: "text-lavender",
  flaunch: "text-pink",
  zora: "text-accent",
  zora_creator: "text-accent",
  baseapp: "text-lavender",
  basememe: "text-mint",
  virtuals_v2: "text-pink",
  klik: "text-accent",
  fourmeme: "text-accent",
  flap: "text-mint",
  lunafun: "text-lavender",
};

// Launchpad → display label + the domain whose favicon is the brand mark.
const LAUNCHPAD_META: Record<string, { label: string; domain?: string }> = {
  clanker: { label: "Clanker", domain: "clanker.world" },
  bankr: { label: "Bankr", domain: "bankr.bot" },
  flaunch: { label: "Flaunch", domain: "flaunch.gg" },
  zora: { label: "Zora", domain: "zora.co" },
  zora_creator: { label: "Zora", domain: "zora.co" },
  baseapp: { label: "Base", domain: "base.app" },
  basememe: { label: "BaseMeme" },
  virtuals_v2: { label: "Virtuals", domain: "virtuals.io" },
  klik: { label: "Klik" },
  fourmeme: { label: "four.meme", domain: "four.meme" },
  flap: { label: "Flap" },
  lunafun: { label: "LunaFun" },
};

// Small launchpad mark overlaid on the token avatar's corner (GMGN-style).
function LaunchpadMark({ name }: { name: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!name) return null;
  const key = name.toLowerCase();
  const meta = LAUNCHPAD_META[key];
  const label = meta?.label ?? name;

  if (meta?.domain && !failed) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${meta.domain}&sz=64`}
        alt={label}
        title={label}
        onError={() => setFailed(true)}
        className="absolute -bottom-1 -right-1 h-4 w-4 rounded-[5px] border-2 border-base bg-base object-cover"
      />
    );
  }

  const color = LAUNCHPAD_COLOR[key] ?? "text-muted";
  return (
    <span
      title={label}
      className={`absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-[5px] border-2 border-base bg-surface-2 text-[8px] font-bold uppercase ${color}`}
    >
      {label.slice(0, 1)}
    </span>
  );
}

function normalizeSocial(value: string, base: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return base + value.replace(/^@/, "");
}

function Socials({
  twitter,
  website,
  telegram,
}: {
  twitter: string | null;
  website: string | null;
  telegram: string | null;
}) {
  const links: { key: string; href: string; title: string; icon: ReactNode }[] = [];
  if (website) links.push({ key: "web", href: normalizeSocial(website, "https://"), title: "Website", icon: <GlobeIcon /> });
  if (twitter) links.push({ key: "x", href: normalizeSocial(twitter, "https://x.com/"), title: "X / Twitter", icon: <XIcon /> });
  if (telegram) links.push({ key: "tg", href: normalizeSocial(telegram, "https://t.me/"), title: "Telegram", icon: <TelegramIcon /> });
  if (!links.length) return null;
  return (
    <span className="flex items-center gap-1.5">
      {links.map((l) => (
        <button
          key={l.key}
          title={l.title}
          onClick={(e) => {
            e.stopPropagation();
            openUrl(l.href).catch(() => {});
          }}
          className="text-muted transition-colors hover:text-fg"
        >
          {l.icon}
        </button>
      ))}
    </span>
  );
}

const sIcon = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function GlobeIcon() {
  return (
    <svg {...sIcon}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
function TelegramIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.94 4.6l-3.32 15.64c-.25 1.1-.9 1.38-1.83.86l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1 .5l.36-5.13 9.34-8.44c.4-.36-.09-.56-.63-.2L4.5 13.13l-4.97-1.56c-1.08-.34-1.1-1.08.23-1.6l19.43-7.49c.9-.33 1.69.2 1.4 1.42z" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="mt-2.5">
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>Bonding</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

type MetricTone = "good" | "bad" | "warn" | "muted";

// GMGN-style: a small monochrome icon + a colour-coded value. No chunky pills.
function Metric({
  icon,
  value,
  tone,
  title,
}: {
  icon: ReactNode;
  value: string;
  tone: MetricTone;
  title: string;
}) {
  const color =
    tone === "bad"
      ? "text-pink"
      : tone === "warn"
        ? "text-accent"
        : tone === "good"
          ? "text-mint"
          : "text-fg/80";
  return (
    <span title={title} className="flex items-center gap-1">
      <span className="text-muted">{icon}</span>
      <span className={color}>{value}</span>
    </span>
  );
}

function pctLabel(rate: number | null): string {
  if (rate == null) return "—";
  const p = rate * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

function rateTone(rate: number | null, warnAbove: number): MetricTone {
  if (rate == null) return "muted";
  return rate > warnAbove ? "bad" : "good";
}

const mIcon = {
  width: 12,
  height: 12,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function UsersIcon() {
  return (
    <svg {...mIcon}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5" />
      <path d="M16 4.5a3 3 0 0 1 0 6M21 20c0-2.8-1.6-4.4-4-4.8" />
    </svg>
  );
}
function DevIcon() {
  return (
    <svg {...mIcon}>
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg {...mIcon}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function TargetIcon() {
  return (
    <svg {...mIcon}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
    </svg>
  );
}
function DropIcon() {
  return (
    <svg {...mIcon}>
      <path d="M12 3s6 6 6 11a6 6 0 0 1-12 0c0-5 6-11 6-11z" />
    </svg>
  );
}
function TaxIcon() {
  return (
    <svg {...mIcon}>
      <path d="M5 19 19 5" />
      <circle cx="7.5" cy="7.5" r="1.6" />
      <circle cx="16.5" cy="16.5" r="1.6" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg {...mIcon} fill="currentColor" stroke="none">
      <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.2l1-5.8L3.5 9.2l5.9-.9z" />
    </svg>
  );
}
function ShieldCheckIcon() {
  return (
    <svg {...mIcon}>
      <path d="M12 3l7 2.5v5.2c0 4.4-3 8.1-7 9.3-4-1.2-7-4.9-7-9.3V5.5L12 3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg {...mIcon}>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

function BuyButton({
  disabled,
  busy,
  label = "Buy",
  onClick,
}: {
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || !onClick}
      className={`shrink-0 rounded-pill px-3 py-1.5 text-xs font-bold transition-transform hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed ${
        busy ? "bg-surface-2 text-muted" : "bg-accent text-base"
      }`}
      title="Buy via your own non-custodial swap"
    >
      {label}
    </button>
  );
}

function taxLabel(buy: number | null, sell: number | null): string | null {
  if (buy == null && sell == null) return null;
  const b = buy != null ? Math.round(buy * 100) : 0;
  const s = sell != null ? Math.round(sell * 100) : 0;
  if (b === 0 && s === 0) return null;
  return `Tax ${b}/${s}%`;
}

function highTax(buy: number | null, sell: number | null): boolean {
  return (buy ?? 0) > 0.1 || (sell ?? 0) > 0.1;
}

function ColumnSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-xl border border-border bg-base"
        />
      ))}
    </>
  );
}

function EmptyColumn({ errored }: { errored: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <p className="text-sm font-semibold text-muted">No launches</p>
      <p className="mt-1 text-xs text-muted">
        {errored
          ? "Feed unavailable — check the GMGN key in the backend (.env)."
          : "Nothing in this stage right now. Check back shortly."}
      </p>
    </div>
  );
}
