import { TokenLogo } from '../TokenLogo';
import { isFundingAddress, relayNetwork, sameAddress, type TradeToken } from './model';

export function TokenAvatar({ token }: { token: TradeToken }) {
  const network = relayNetwork(token.chainId);
  const isFunding = isFundingAddress(network, token.address);
  const isNative = sameAddress(token.address, network.native, network.vm);
  // Only pinned Circle-issued USDC gets the USDC mark; Binance-Peg USDC, USDG and other tokens never borrow it.
  const isUsdc = isFunding && network.funding.circleIssued;
  return <span className={`trade-coin ${isUsdc ? 'trade-coin-usdc' : ''}`} aria-hidden="true">
    {isFunding || isNative ? <TokenLogo symbol={isNative ? network.nativeSymbol : isUsdc ? 'USDC' : 'stablecoin'} /> : token.symbol.slice(0, 2)}
  </span>;
}
