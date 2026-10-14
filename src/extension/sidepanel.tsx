// Primary extension surface: the Chrome side panel. The toolbar icon opens it
// directly (no action popup), and it stays open while the user switches focus, so
// email OTP and MFA prompts are not interrupted. At panel widths (<= 640px) the
// wallet uses its existing mobile layout. A slim bar above the wallet offers the
// same wallet in a full browser tab (the same hand-off vault-layer ceremonies use).
import { useState } from 'react';
import { isWalletRoute, openWalletTab } from '../platform/layers';
import { mountWallet } from './mountWallet';

function SidePanelBar() {
  const [problem, setProblem] = useState('');
  const openFullTab = () => {
    // Only the wallet's own short page anchors (#portfolio, #vault, ...) are carried over.
    const hash = window.location.hash;
    setProblem('');
    // One wallet page at a time: openWalletTab closes the panel once the tab is
    // open, so two Privy sessions do not refresh the same login concurrently.
    openWalletTab(isWalletRoute(hash) ? hash : undefined)
      .then(opened => { if (!opened) setProblem('Open ANTARA from the Chrome toolbar.'); })
      .catch(() => setProblem('Chrome did not open a new tab.'));
  };
  return (
    <div className="extension-panel-bar">
      <span className="extension-panel-bar-label">Side panel</span>
      {problem && <span className="extension-panel-bar-problem" role="status">{problem}</span>}
      <button type="button" className="extension-panel-bar-button" onClick={openFullTab}>
        Open in full tab <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

mountWallet(<SidePanelBar />);
