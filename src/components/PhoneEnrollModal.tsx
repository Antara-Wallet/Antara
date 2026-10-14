import { useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";
import { phoneEnrollStore } from "../lib/phoneEnroll";

/**
 * In-app QR for phone Face ID (enroll + approve). Mounted once at the app root;
 * shows whenever the flow pushes a prompt into phoneEnrollStore. Styled to match
 * the app's other modals (SendModal etc.), not the marketing site.
 */
export function PhoneEnrollModal() {
  const prompt = useSyncExternalStore(
    phoneEnrollStore.subscribe,
    phoneEnrollStore.get,
    phoneEnrollStore.get
  );
  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6 text-center">
        <h2 className="text-lg font-bold">{prompt.title}</h2>
        <p className="mt-2 text-sm text-muted">{prompt.subtitle}</p>

        <div className="mx-auto mt-5 w-fit rounded-2xl bg-white p-3">
          <QRCodeSVG value={prompt.url} size={208} bgColor="#ffffff" fgColor="#0a0a0b" marginSize={2} />
        </div>

        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          Waiting for your phone…
        </div>

        <button
          type="button"
          onClick={() => phoneEnrollStore.cancel()}
          className="mt-5 w-full rounded-pill border border-border px-6 py-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
