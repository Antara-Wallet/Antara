export function Logo({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <img
        src="/antara/emblem.png"
        alt="ANTARA"
        width={size}
        height={size}
        className="shrink-0 object-contain"
      />
      <span className="text-[17px] font-bold tracking-tight">ANTARA</span>
    </div>
  );
}
