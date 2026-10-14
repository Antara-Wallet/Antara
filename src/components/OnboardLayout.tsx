import type { ReactNode } from "react";
import { Logo } from "./Logo";

export function OnboardLayout({
  children,
  step,
  totalSteps,
}: {
  children: ReactNode;
  step?: number;
  totalSteps?: number;
}) {
  return (
    <div className="flex h-full w-full">
      {/* Left: form panel */}
      <div className="flex w-full flex-col px-10 py-9 lg:w-[46%] lg:px-16">
        <Logo />
        {typeof step === "number" && typeof totalSteps === "number" && (
          <div className="mt-8 flex gap-2">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-pill transition-colors ${
                  i <= step ? "bg-accent" : "bg-border"
                }`}
              />
            ))}
          </div>
        )}
        <div className="flex flex-1 flex-col justify-center">{children}</div>
      </div>

      {/* Right: pastel art */}
      <div className="relative hidden flex-1 overflow-hidden lg:block">
        <BrandArt />
      </div>
    </div>
  );
}

function BrandArt() {
  return (
    <img
      src="/solares/horizon.png"
      alt=""
      className="absolute inset-0 h-full w-full object-cover object-right"
      draggable={false}
    />
  );
}
