import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import './index.css';

const AntaraLanding = lazy(() => import('./solares/landing/AntaraLanding'));
const WalletApp = lazy(() => import('./solares/WalletApp'));
const LegacyApp = lazy(() => import('./App'));
const LegacyRetired = lazy(() => import('./solares/LegacyRetired'));
const Enroll = lazy(() => import('./screens/Enroll').then(m => ({ default: m.Enroll })));
const Approve = lazy(() => import('./screens/Approve').then(m => ({ default: m.Approve })));
const Guide = lazy(() => import('./solares/Guide'));
const DownloadPage = lazy(() => import('./solares/download/DownloadPage'));
const walletHashes = new Set(['portfolio', 'protection', 'tokens', 'activity', 'vault', 'vaults', 'swap', 'agents', 'browser', 'settings', 'overview', 'discover', 'wallet', 'trade']);

function Root() {
  const [location, setLocation] = useState(() => ({ path: window.location.pathname, hash: window.location.hash }));
  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, hash: window.location.hash });
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  const clean = location.path.replace(/\/+$/, '');
  const short = clean.match(/^\/e\/([A-Za-z0-9]+)$/i);
  if (short) { window.location.replace(`/enroll?c=${short[1].toUpperCase()}`); return null; }
  let screen: React.ReactNode;
  if (clean === '/enroll') screen = <Enroll />;
  else if (clean === '/approve') screen = <Approve />;
  // Native builds no longer grant the local keystore's signing commands, so the old workspace is retired there.
  else if (clean.startsWith('/legacy')) screen = isTauri() ? <LegacyRetired /> : <LegacyApp />;
  else if (clean.startsWith('/docs') || clean === '/skill') screen = <Guide />;
  else if (clean === '/download' || clean === '/downloads') screen = <DownloadPage />;
  else if (clean === '/landing' || (clean === '' && !isTauri() && !walletHashes.has(location.hash.slice(1).toLowerCase()))) screen = <AntaraLanding />;
  else screen = <WalletApp />;
  return <Suspense fallback={<div style={{ background: '#050507', height: '100vh', display: 'grid', placeItems: 'center', color: '#b9d9ff', letterSpacing: '.3em' }}>ANTARA</div>}>{screen}</Suspense>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
