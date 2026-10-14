import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOC_PAGES } from './docs/registry';
import { friendlyError } from '../lib/errors';
import { COMMON_TOKENS, NATIVE } from '../lib/tokens';

// User-facing network copy outside the network registry: the legacy ARK gas
// error, the legacy swap token lists and the public docs pages. Kept under
// src/solares so the existing test:unit glob runs it.

const GAS_ERROR = new Error('insufficient funds for gas * price + value: address 0xabc have 0 want 1\nRequest Arguments: ...');
const CHAIN_NAMES = ['Solana', 'Ethereum', 'BNB', 'BSC', 'Robinhood', 'Base', 'Arbitrum', 'Polygon'];

test('legacy gas error names the network and gas token it is given', () => {
  const base = friendlyError(GAS_ERROR, { network: 'Base', gasSymbol: 'ETH' });
  assert.equal(base, 'Not enough ETH on Base to cover gas. Add a little ETH to your wallet, then try again.');
  const funded = friendlyError(GAS_ERROR, { fundAddress: '0x1234567890abcdef1234567890abcdef12345678', network: 'Ethereum', gasSymbol: 'ETH' });
  assert.equal(funded, 'Not enough ETH on Ethereum to cover gas. Add a little ETH to your wallet (0x1234…5678), then try again.');
});

test('legacy gas error without context names no chain and no specific gas token', () => {
  const neutral = friendlyError(GAS_ERROR);
  assert.equal(neutral, 'Not enough native gas token to cover gas. Add a little native gas token to your wallet, then try again.');
  for (const name of [...CHAIN_NAMES, 'ETH']) assert.ok(!neutral.includes(name), `context-free message must not name ${name}`);
});

test('legacy friendly errors never relabel a chain as Robinhood', () => {
  const raw = [GAS_ERROR, new Error('User rejected the request.'), new Error('Failed to fetch'), new Error('nonce too low'), new Error('execution reverted'), 'plain failure'];
  const contexts = [undefined, { network: 'Base', gasSymbol: 'ETH' }, { network: 'Ethereum', gasSymbol: 'ETH' }, { fundAddress: '0x1234567890abcdef1234567890abcdef12345678' }];
  for (const error of raw) for (const ctx of contexts) assert.doesNotMatch(friendlyError(error, ctx), /robinhood/i);
});

test('the legacy workspace offers only Ethereum and Base; Polygon is gone', () => {
  assert.deepEqual(Object.keys(NATIVE).sort(), ['base', 'ethereum']);
  assert.deepEqual(Object.keys(COMMON_TOKENS).sort(), ['base', 'ethereum']);
  for (const tokens of Object.values(COMMON_TOKENS)) assert.ok(!tokens.some(token => ['POL', 'WMATIC'].includes(token.symbol)));
});

test('the docs are Solana-first, name each funding stablecoin honestly and describe MFA as the vault authenticator', () => {
  // Every docs page, as the reader sees it (Guide itself picks one page from window.location).
  const text = DOC_PAGES.map(page => renderToStaticMarkup(createElement(page.Component))).join(' ')
    .replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  assert.ok(text.includes('ANTARA is a Solana-first wallet for Solana, Ethereum, BNB Smart Chain, Robinhood Chain and Base'));
  assert.ok(text.includes('Binance-Peg USDC is a bridged token issued by Binance, not Circle'));
  assert.ok(text.includes('there is no Circle USDC on this network. ANTARA uses USDG (Paxos Global Dollar) and never calls it USDC.'));
  assert.ok(text.includes('Arbitrum and Polygon are no longer supported anywhere in ANTARA.'));
  // Swap terms and vault limits are stated, never as guarantees.
  assert.ok(text.includes('its amount is not guaranteed'));
  assert.ok(text.includes('If you lose access to your ANTARA login, vault funds cannot be released.'));
  assert.ok(text.includes('Releases pause.'));
  // MFA is the vault's own optional authenticator (owner decision 2026-10-13), never Privy wallet MFA.
  assert.ok(text.includes('Your regular wallet never asks for an MFA code.'));
  assert.ok(text.includes('Turning MFA off applies at once'));
  // Owner decision 2026-10-13: no 24-hour change delays, no recipient link age, no ANTARA release or swap caps.
  // Limits is optional, with caps the user sets; only the 7-day lost-device recovery waits.
  assert.doesNotMatch(text, /24 hours|24-hour|linked to your account for at least|0\.5 SOL|50 USDC|200 USDC|Always on|Swap caps|caps on swaps|per account, rolling|capped|per swap/i);
  assert.ok(text.includes('Limits is optional and off by default'));
  assert.ok(text.includes('ANTARA sets no swap cap'));
  assert.doesNotMatch(text, /Privy (may )?(also )?asks? for (a|the|its) code|vault-only (MFA )?code is in progress|Vault-only MFA code|authenticator app on your ANTARA account/i);
  assert.ok(!text.includes('Open the legacy desktop workspace'));
  assert.doesNotMatch(text, /Ethereum at the center|Ethereum, beyond borders|USDC on Robinhood/);
});
