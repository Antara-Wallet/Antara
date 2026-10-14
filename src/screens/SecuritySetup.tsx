import { useState, type ReactNode } from "react";
import { OnboardLayout } from "../components/OnboardLayout";
import {
  FaceIdIcon,
  BluetoothIcon,
  UsbIcon,
  GeoIcon,
} from "../components/Icons";
import { getDefaultLayers, setDefaultLayers, type VaultLayers } from "../lib/safe";

const LAYERS: {
  key: keyof VaultLayers;
  label: string;
  desc: string;
  Icon: (p: { size?: number; className?: string }) => ReactNode;
}[] = [
  { key: "faceId", label: "Face ID", desc: "Windows Hello / Touch ID, or approve on your phone", Icon: FaceIdIcon },
  { key: "usb", label: "USB device", desc: "A specific USB key must be plugged in", Icon: UsbIcon },
  { key: "bluetooth", label: "Bluetooth device", desc: "A paired device must be connected nearby", Icon: BluetoothIcon },
  { key: "geo", label: "Geo location", desc: "Transfers only from an approved location", Icon: GeoIcon },
];

/**
 * Onboarding security step. The user chooses which layers their vault should
 * require; the co-signer enforces them on every transfer. Saved as defaults that
 * pre-fill vault creation — the exact device / geo-fence is bound there.
 */
export function SecuritySetup({ onNext }: { onNext: () => void }) {
  const [layers, setLayers] = useState<VaultLayers>(getDefaultLayers);

  function toggle(key: keyof VaultLayers) {
    setLayers((l) => ({ ...l, [key]: !l[key] }));
  }

  function finish() {
    setDefaultLayers(layers);
    onNext();
  }

  function skip() {
    setDefaultLayers({ faceId: false, bluetooth: false, usb: false, geo: false });
    onNext();
  }

  const anyOn = Object.values(layers).some(Boolean);

  return (
    <OnboardLayout>
      <div className="flex max-w-md flex-col" style={{ maxHeight: "80vh" }}>
        <h1 className="text-3xl font-bold tracking-tight">Choose your security layers</h1>
        <p className="mt-3 text-[15px] text-muted">
          ANTARA co-signs every transfer only when these checks pass. Pick what to
          require — you can change this anytime when you create your vault.
        </p>

        <div className="mt-6 flex-1 space-y-2 overflow-y-auto pr-1">
          {LAYERS.map((m) => (
            <button
              key={m.key}
              onClick={() => toggle(m.key)}
              className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors ${
                layers[m.key] ? "border-accent/50 bg-accent/5" : "border-border bg-surface hover:border-muted"
              }`}
            >
              <span className={`shrink-0 ${layers[m.key] ? "text-accent" : "text-muted"}`}>
                <m.Icon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{m.label}</p>
                <p className="truncate text-xs text-muted">{m.desc}</p>
              </div>
              <span
                className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                  layers[m.key] ? "bg-accent" : "bg-surface-2"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full bg-white transition-transform ${
                    layers[m.key] ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </span>
            </button>
          ))}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={skip}
            className="rounded-pill border border-border bg-surface px-5 py-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Skip for now
          </button>
          <button
            onClick={finish}
            className="flex-1 rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform hover:scale-[1.02] active:scale-95"
          >
            {anyOn ? "Continue" : "Continue without layers"}
          </button>
        </div>
      </div>
    </OnboardLayout>
  );
}
