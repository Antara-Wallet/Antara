// Anchor for links that leave ANTARA (block explorers, docs). A plain
// target="_blank" link does nothing in the desktop app, because WebView2 blocks new
// windows, so every click goes through openExternal: the system browser on
// desktop, a new browser tab in the extension, a no-opener tab on the web.
// The href stays for copy-link and accessibility.
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { openExternal, safeExternalUrl } from './index';

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string;
  children?: ReactNode;
};

export function ExternalLink({ href, onClick, children, ...props }: ExternalLinkProps) {
  const safe = safeExternalUrl(href);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!safe) return;
    openExternal(safe).catch(error => console.warn('[ANTARA] Could not open the link:', error instanceof Error ? error.message : error));
  };
  // A refused URL (not plain http/https) renders without an href, so it cannot be followed.
  return <a {...props} href={safe ?? undefined} target="_blank" rel="noopener noreferrer" onClick={handleClick} aria-disabled={safe ? undefined : true}>{children}</a>;
}
