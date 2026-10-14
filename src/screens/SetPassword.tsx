import { useState } from "react";
import { OnboardLayout } from "../components/OnboardLayout";

export function SetPassword({
  onNext,
}: {
  onNext: (password: string) => void | Promise<void>;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const strength = scorePassword(pw);
  const match = pw.length > 0 && pw === confirm;
  const canContinue = strength >= 2 && match && !busy;

  async function submit() {
    if (!canContinue) return;
    setBusy(true);
    setError("");
    try {
      await onNext(pw);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <OnboardLayout step={0} totalSteps={3}>
      <div className="max-w-sm">
        <h1 className="text-3xl font-bold tracking-tight">Create a password</h1>
        <p className="mt-3 text-[15px] text-muted">
          This unlocks ANTARA on this device. It never leaves your computer.
        </p>

        <div className="mt-8 flex flex-col gap-4">
          <Field
            label="Password"
            value={pw}
            onChange={setPw}
            placeholder="Enter a strong password"
          />
          {pw.length > 0 && (
            <div className="flex gap-1.5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-pill ${
                    i < strength
                      ? strength === 1
                        ? "bg-pink"
                        : strength === 2
                          ? "bg-accent"
                          : "bg-mint"
                      : "bg-border"
                  }`}
                />
              ))}
            </div>
          )}
          <Field
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            placeholder="Re-enter your password"
          />
          {confirm.length > 0 && !match && (
            <p className="text-xs text-pink">Passwords don't match.</p>
          )}
          {error && <p className="text-xs text-pink">{error}</p>}
        </div>

        <button
          disabled={!canContinue}
          onClick={submit}
          className="mt-9 w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-semibold text-base transition-transform enabled:hover:scale-[1.02] enabled:active:scale-95 disabled:opacity-40"
        >
          {busy ? "Securing…" : "Continue"}
        </button>
      </div>
    </OnboardLayout>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent"
      />
    </label>
  );
}

function scorePassword(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw)) s++;
  if (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}
