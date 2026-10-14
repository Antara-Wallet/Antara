import { useState } from "react";
import { OnboardLayout } from "../components/OnboardLayout";
import { unlockVault, type Account } from "../lib/vault";

export function Unlock({ onUnlocked }: { onUnlocked: (a: Account[]) => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pw || busy) return;
    setBusy(true);
    setError("");
    try {
      onUnlocked(await unlockVault(pw));
    } catch (e) {
      setError(String(e).includes("invalid password") ? "Wrong password." : String(e));
      setPw("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardLayout>
      <div className="max-w-sm">
        <h1 className="text-3xl font-bold tracking-tight">Welcome back</h1>
        <p className="mt-3 text-[15px] text-muted">
          Enter your password to unlock ARK on this device.
        </p>

        <div className="mt-8">
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Password"
            className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent"
          />
          {error && <p className="mt-2 text-xs text-pink">{error}</p>}
        </div>

        <button
          disabled={!pw || busy}
          onClick={submit}
          className="mt-8 w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-semibold text-base transition-transform enabled:hover:scale-[1.02] enabled:active:scale-95 disabled:opacity-40"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </div>
    </OnboardLayout>
  );
}
