import { useState } from "react";
import { OnboardLayout } from "../components/OnboardLayout";
import { isValidMnemonic } from "../lib/wallet";

export function ImportWallet({
  onImport,
}: {
  onImport: (mnemonic: string) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const trimmed = phrase.trim().replace(/\s+/g, " ");
  const wordCount = trimmed ? trimmed.split(" ").length : 0;
  const valid = (wordCount === 12 || wordCount === 24) && isValidMnemonic(trimmed);

  return (
    <OnboardLayout step={0} totalSteps={2}>
      <div className="max-w-md">
        <h1 className="text-3xl font-bold tracking-tight">
          Import your wallet
        </h1>
        <p className="mt-3 text-[15px] text-muted">
          Enter your 12 or 24-word recovery phrase, separated by spaces.
        </p>

        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="word1 word2 word3 …"
          rows={4}
          className="mt-6 w-full resize-none rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent"
        />

        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-muted">{wordCount} words</span>
          {wordCount > 0 && !valid && (
            <span className="text-pink">Not a valid recovery phrase</span>
          )}
        </div>

        <button
          disabled={!valid}
          onClick={() => onImport(trimmed)}
          className="mt-8 w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-semibold text-base transition-transform enabled:hover:scale-[1.02] enabled:active:scale-95 disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </OnboardLayout>
  );
}
