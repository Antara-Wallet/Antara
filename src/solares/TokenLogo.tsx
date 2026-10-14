export function TokenLogo({ symbol }: { symbol: string }) {
  const token = symbol.toLowerCase();
  return (
    <svg className="desktop-token-logo" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {token === "sol" || token === "solana" ? (
        <>
          <path d="m6.2 4.5-3.4 3.4h15l3.4-3.4H6.2Z" fill="currentColor" />
          <path d="m2.8 10.3 3.4 3.4h15l-3.4-3.4h-15Z" fill="currentColor" opacity=".78" />
          <path d="m6.2 16.1-3.4 3.4h15l3.4-3.4h-15Z" fill="currentColor" opacity=".56" />
        </>
      ) : token === "eth" || token === "ethereum" ? (
        <>
          <path d="M12 1.5 5.5 12 12 15.8 18.5 12 12 1.5Z" fill="currentColor" opacity=".86" />
          <path d="M12 1.5V15.8L18.5 12 12 1.5Z" fill="currentColor" opacity=".4" />
          <path d="M5.5 13.4 12 22.5l6.5-9.1L12 17.2l-6.5-3.8Z" fill="currentColor" />
        </>
      ) : token === "usdc" ? (
        <>
          <path d="M8.1 3.7a9.2 9.2 0 0 0 0 16.6M15.9 3.7a9.2 9.2 0 0 1 0 16.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M15.1 8.4c-.5-1-1.5-1.5-3-1.5-1.8 0-2.8.9-2.8 2.2 0 3.4 5.7 1.7 5.7 5.1 0 1.4-1.2 2.4-3 2.4-1.5 0-2.7-.7-3.2-1.8M12 5.3v1.6m0 9.7v2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : token === "base" ? (
        <>
          <circle cx="12" cy="12" r="9.5" fill="currentColor" />
          <path d="M2 12h14.5" stroke="#080a10" strokeWidth="2" />
        </>
      ) : token === "bnb" || token === "bsc" ? (
        <>
          <path d="m12 3.2 3 3-3 3-3-3 3-3Zm-5.8 5.8 3 3-3 3-3-3 3-3Zm11.6 0 3 3-3 3-3-3 3-3ZM12 14.8l3 3-3 3-3-3 3-3Z" fill="currentColor" />
          <path d="m12 10.3 1.7 1.7-1.7 1.7-1.7-1.7 1.7-1.7Z" fill="currentColor" opacity=".7" />
        </>
      ) : token === "stablecoin" || token === "usdg" ? (
        // Neutral stablecoin mark: never the Circle USDC mark for another issuer's token.
        <>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M14.6 9.2c-.4-.8-1.3-1.3-2.6-1.3-1.5 0-2.4.8-2.4 1.9 0 2.8 5 1.4 5 4.3 0 1.2-1 2-2.6 2-1.3 0-2.3-.6-2.8-1.5M12 6.4v1.5m0 8.3v1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 8h4a2 2 0 0 1 0 4H9m0 0h4a2 2 0 0 1 0 4H9V8" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}
