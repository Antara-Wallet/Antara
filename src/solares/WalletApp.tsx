import SolaresApp from './SolaresApp';
import { SolaresWalletProvider } from './wallet';

/** Keep account providers and signing dependencies out of the public landing route. */
export default function WalletApp() {
  return <SolaresWalletProvider><SolaresApp /></SolaresWalletProvider>;
}
