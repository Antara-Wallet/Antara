import { useEffect, useRef, useState } from 'react';
import { AddressText, Icon, Sheet } from '../ui';
import { TokenAvatar } from './TokenAvatar';
import { RELAY_API } from './client';
import { initialCurrencies, parseCurrencies } from './currencies';
import { RELAY_NETWORKS, receivingEnabled, sameAddress, tokenLabel, tradeNetwork, type TradeToken } from './model';

/**
 * The receive-token picker (docs/UI_ARGUS_PARITY.md 6.10), on the shared Sheet: a centred
 * dialog on desktop, a bottom sheet at 640px and below. Identity only (symbol, name, network,
 * contract): no price, volume or liquidity. `sourceChainId` is the pay network: receiving
 * networks that are not enabled from it cannot be chosen.
 */
export function TokenPicker({ selected, sourceChainId, onSelect, onClose }: { selected: TradeToken; sourceChainId: number; onSelect: (token: TradeToken) => void; onClose: () => void }) {
  const [chainId, setChainId] = useState(selected.chainId);
  const [term, setTerm] = useState('');
  const [tokens, setTokens] = useState<TradeToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const network = tradeNetwork(chainId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setTokens([]); setError('');
    const timer = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ chainId: String(chainId), term: term.trim() });
        const response = await fetch(`${RELAY_API}/currencies?${query}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error('Token search is unavailable. Try again.');
        const found = parseCurrencies(data.tokens, chainId);
        if (!controller.signal.aborted) setTokens(found);
      } catch {
        if (!controller.signal.aborted) setError('Token search is unavailable. Try again.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, term ? 300 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [chainId, term, retry]);

  const defaults = term.trim() ? [] : initialCurrencies(chainId);
  const results = [...defaults, ...tokens.filter(token => token.chainId === chainId && !defaults.some(item => sameAddress(item.address, token.address, network.vm)))];
  return (
    <Sheet title="Select a token" closeLabel="Close token selector" onClose={onClose} initialFocus={search} className="swap-sheet swap-picker">
      <div className="swap-picker-controls">
        <label className="swap-picker-network">
          <span>Network</span>
          <select aria-label="Token network" value={chainId} onChange={event => { setChainId(Number(event.target.value)); setTerm(''); }}>
            {RELAY_NETWORKS.map(chain => <option key={chain.id} value={chain.id} disabled={!receivingEnabled(sourceChainId, chain.id)}>{receivingEnabled(sourceChainId, chain.id) ? chain.name : `${chain.name} (same-network swaps only)`}</option>)}
          </select>
        </label>
        <div className="swap-picker-search">
          <Icon name="search" size={17} />
          <input ref={search} aria-label="Search tokens" placeholder="Search name or paste address" value={term} maxLength={100} autoComplete="off" spellCheck={false} onChange={event => setTerm(event.target.value)} />
        </div>
      </div>
      <div className="swap-picker-results" aria-busy={loading}>
        {!term.trim() && <p className="swap-picker-group ui-eyebrow">On {network.name}</p>}
        {results.map(token => {
          const native = sameAddress(token.address, network.native, network.vm);
          const chosen = token.chainId === selected.chainId && sameAddress(token.address, selected.address, network.vm);
          return (
            <button type="button" className="swap-picker-row" key={token.address} data-selected={chosen || undefined} onClick={() => onSelect(token)}>
              <TokenAvatar token={token} />
              <span className="swap-picker-identity">
                <strong>{tokenLabel(token)}</strong>
                <small>{token.name}</small>
                {native
                  ? <code>Native token · {network.name}</code>
                  : <span className="swap-picker-contract"><span>{network.name} · </span><AddressText address={token.address} /></span>}
              </span>
              {chosen && <span className="swap-picker-check" aria-label="Selected"><Icon name="check" size={17} /></span>}
            </button>
          );
        })}
        {loading && <p role="status" className="swap-picker-state">Searching tokens…</p>}
        {error && <div className="swap-picker-state swap-picker-error" role="status">{error}<button type="button" className="ui-btn-text" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
        {!loading && !error && results.length === 0 && <p role="status" className="swap-picker-state">No tokens found on {network.name}. Try the contract address.</p>}
      </div>
      <p className="swap-picker-note">Match the contract address before selecting a token. Availability depends on liquidity.</p>
    </Sheet>
  );
}
