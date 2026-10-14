type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function CoinIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

export function AgentIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.2v3.8" />
      <circle cx="12" cy="3.6" r="1.1" />
      <path d="M9 12.5v1.5M15 12.5v1.5" />
      <path d="M9.5 16.5h5" />
    </svg>
  );
}

export function TokenIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10.5h3.5a1.5 1.5 0 0 1 0 3H9.5h4" />
    </svg>
  );
}

export function ActivityIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function ShieldIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3l7 2.5v5.2c0 4.4-3 8.1-7 9.3-4-1.2-7-4.9-7-9.3V5.5L12 3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function LockIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function FaceIdIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 10v1M15 10v1M12 10v3l-1 1" />
      <path d="M9.5 15.5s1 1 2.5 1 2.5-1 2.5-1" />
    </svg>
  );
}

export function BluetoothIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 7l10 10-5 4V3l5 4L7 17" />
    </svg>
  );
}

export function UsbIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      {/* USB trident: stem, arrowhead, round node + square node on the branches */}
      <path d="M12 5.5V20" />
      <path d="M12 2.4l2.3 3.6H9.7z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20.4" r="1.7" fill="currentColor" stroke="none" />
      <path d="M12 13.2L8.4 9.6" />
      <circle cx="8" cy="9.2" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 10.6l3.6-3.6" />
      <path d="M15.6 4.9l1.5 1.5-1.5 1.5-1.5-1.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GeoIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 21c4-4.5 6-7.8 6-11a6 6 0 1 0-12 0c0 3.2 2 6.5 6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

export function VoiceIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v3M9 20h6" />
    </svg>
  );
}

export function SettingsIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function DownloadIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function DocsIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M13 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h7" />
    </svg>
  );
}

// The X (formerly Twitter) glyph. Solid mark, so it ignores the stroke base.
export function XIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M17.53 3H20.5l-6.49 7.41L21.75 21h-6.0l-4.7-6.14L5.6 21H2.63l6.94-7.93L2.25 3h6.15l4.25 5.62L17.53 3zm-1.04 16.2h1.64L7.6 4.71H5.84L16.49 19.2z" />
    </svg>
  );
}

export function TrenchIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <circle cx="12" cy="12" r="6" />
      <path d="M12 12l3.2-3.2" />
    </svg>
  );
}
