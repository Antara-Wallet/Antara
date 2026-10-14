// Lightweight update check: fetch a version manifest hosted on the site and, if
// it's newer than the running app, surface a "download the new version" prompt.
// Keys live in the OS app-data dir, so installing a newer build never touches
// them — updating is safe.

export interface UpdateInfo {
  version: string;
  url: string; // where to download the new installer
  notes?: string;
}

const MANIFEST_URL = import.meta.env.VITE_UPDATE_MANIFEST_URL ?? "";

function cmpVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Returns update info if the hosted manifest is newer than `current`, else null. */
export async function checkForUpdate(current: string): Promise<UpdateInfo | null> {
  if (!MANIFEST_URL || !MANIFEST_URL.startsWith("https://")) return null;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const m = (await res.json()) as UpdateInfo;
    // A fork must never download an upstream executable. Keep update downloads
    // on the explicitly configured release origin.
    if (m && m.version && m.url && cmpVersions(m.version, current) > 0 &&
      new URL(m.url).protocol === "https:" && new URL(m.url).origin === new URL(MANIFEST_URL).origin) return m;
    return null;
  } catch {
    return null; // offline / not reachable — just don't prompt
  }
}
