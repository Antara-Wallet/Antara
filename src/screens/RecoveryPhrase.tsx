import { useState } from "react";
import { OnboardLayout } from "../components/OnboardLayout";
import { LockIcon } from "../components/Icons";

export function RecoveryPhrase({
  mnemonic,
  onNext,
}: {
  mnemonic: string;
  onNext: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = mnemonic.split(" ");

  function copy() {
    navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <OnboardLayout step={1} totalSteps={2}>
      <div className="max-w-md">
        <h1 className="text-3xl font-bold tracking-tight">
          Your recovery phrase
        </h1>
        <p className="mt-3 text-[15px] text-muted">
          These 12 words are the only way to restore your wallet. Write them down
          and keep them somewhere safe. Never share them with anyone.
        </p>

        <div className="relative mt-6">
          <div className="grid grid-cols-3 gap-2.5 rounded-2xl border border-border bg-surface p-4">
            {words.map((w, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm"
              >
                <span className="text-muted">{i + 1}</span>
                <span className="font-medium">{w}</span>
              </div>
            ))}
          </div>
          {!revealed && (
            <button
              onClick={() => setRevealed(true)}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-base/70 backdrop-blur-md"
            >
              <LockIcon size={32} />
              <span className="text-sm font-semibold">
                Tap to reveal — make sure no one is watching
              </span>
            </button>
          )}
        </div>

        {revealed && (
          <button
            onClick={copy}
            className="mt-3 text-sm font-medium text-lavender hover:underline"
          >
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        )}

        <label className="mt-6 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={saved}
            disabled={!revealed}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-sm text-muted">
            I've saved my recovery phrase somewhere safe. I understand it can't be
            recovered if I lose it.
          </span>
        </label>

        <button
          disabled={!saved}
          onClick={onNext}
          className="mt-8 w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-semibold text-base transition-transform enabled:hover:scale-[1.02] enabled:active:scale-95 disabled:opacity-40"
        >
          Open my wallet
        </button>
      </div>
    </OnboardLayout>
  );
}
