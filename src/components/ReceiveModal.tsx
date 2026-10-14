import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

/**
 * Receive / deposit. An EVM address is the same on Ethereum and Base (the only
 * chains this legacy workspace reads), so we show one address + QR and note
 * which assets are safe to send.
 */
export function ReceiveModal({
  address,
  name,
  stealth,
  onClose,
}: {
  address: string;
  name: string;
  // When set, this is an ERC-5564 stealth meta-address, not a plain EOA address.
  stealth?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{stealth ? "Receive privately" : "Receive"}</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            ✕
          </button>
        </div>

        <p className="mt-1 text-xs text-muted">
          {stealth ? "Your stealth address" : `Deposit to ${name}`}
        </p>

        <div className="mt-5 flex justify-center">
          <div className="rounded-2xl bg-white p-4">
            <QRCodeSVG value={address} size={184} />
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-border bg-base px-4 py-3">
          <p className="text-xs text-muted">
            {stealth ? "Your stealth address" : "Your address"}
          </p>
          <p className="mt-1 break-all font-mono text-sm">{address}</p>
        </div>

        <button
          onClick={copy}
          className="mt-4 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform hover:scale-[1.01] active:scale-95"
        >
          {copied ? "Copied" : stealth ? "Copy stealth address" : "Copy address"}
        </button>

        <p className="mt-4 text-center text-xs text-muted">
          {stealth
            ? "Share this once. Every payment arrives at a fresh, unlinkable address only you can find and spend."
            : "Works on Ethereum and Base. Only send Ethereum or Base assets to this address."}
        </p>
      </div>
    </div>
  );
}
