// Per-wallet UI metadata: custom label, card background, and hidden flag.
// None of this is sensitive (no key material), so it lives in localStorage,
// keyed by lowercased address so it survives re-derivation on each unlock.

const KEY = "ark.walletMeta.v1";

export interface WalletMeta {
  label?: string;
  background?: string; // Background id (see BACKGROUNDS)
  hidden?: boolean;
}

type Store = Record<string, WalletMeta>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  localStorage.setItem(KEY, JSON.stringify(store));
}

export function getMeta(address: string): WalletMeta {
  return read()[address.toLowerCase()] ?? {};
}

export function setMeta(address: string, patch: Partial<WalletMeta>): void {
  const store = read();
  const key = address.toLowerCase();
  store[key] = { ...store[key], ...patch };
  write(store);
}

// ---- Background presets (shipped banner images + CSS gradients) ----

export interface Background {
  id: string;
  label: string;
  css: string;
}

// Anchor to the top so the image starts at the top edge and any overflow is
// cropped from the BOTTOM.
const cover = (url: string) => `url("${url}") center top / cover no-repeat`;

// Auto-load every image dropped into src/assets/banners — no list editing needed.
const bannerModules = import.meta.glob<string>("../assets/banners/*.{png,jpg,jpeg,webp}", {
  eager: true,
  query: "?url",
  import: "default",
});

// Optional nicer labels; any file not listed gets a title-cased name from its id.
const BANNER_LABELS: Record<string, string> = {
  water: "Water",
  epic: "Epic",
  citadel: "Citadel",
  inferno: "Inferno",
  aegean: "Aegean",
  poseidon: "Poseidon",
  mono: "Mono",
};

const titleCase = (s: string) =>
  s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Preferred display order; unlisted banners follow alphabetically.
const BANNER_ORDER = ["water", "epic", "citadel", "poseidon", "aegean", "inferno", "mono"];

const imageBackgrounds: Background[] = Object.entries(bannerModules)
  .map(([path, url]) => {
    const id = path.split("/").pop()!.replace(/\.[^.]+$/, "");
    return { id, label: BANNER_LABELS[id] ?? titleCase(id), css: cover(url) };
  })
  .sort((a, b) => {
    const ia = BANNER_ORDER.indexOf(a.id);
    const ib = BANNER_ORDER.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

const gradientBackgrounds: Background[] = [
  { id: "ember", label: "Ember", css: "linear-gradient(135deg,#f97316,#b91c1c)" },
  { id: "aurora", label: "Aurora", css: "linear-gradient(135deg,#7c3aed,#ec4899)" },
  { id: "mint", label: "Mint", css: "linear-gradient(135deg,#10b981,#0ea5e9)" },
  { id: "gold", label: "Gold", css: "linear-gradient(135deg,#fbbf24,#f59e0b)" },
  { id: "violet", label: "Violet", css: "linear-gradient(135deg,#6366f1,#8b5cf6)" },
  { id: "rose", label: "Rose", css: "linear-gradient(135deg,#fb7185,#e11d48)" },
  { id: "ocean", label: "Ocean", css: "linear-gradient(135deg,#0ea5e9,#1e3a8a)" },
  { id: "slate", label: "Slate", css: "linear-gradient(135deg,#475569,#1e293b)" },
];

export const BACKGROUNDS: Background[] = [{ id: "solares-horizon", label: "ANTARA · Horizon", css: cover('/solares/horizon.png') }, ...imageBackgrounds, ...gradientBackgrounds];

export const DEFAULT_BACKGROUND = BACKGROUNDS[0].id;

export function backgroundCss(id?: string): string {
  return (BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0]).css;
}
