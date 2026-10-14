import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COPY_MESSAGES, copyText, shortAddress, splitAddress } from './address';
import { FOCUSABLE, createModalStack, trapTarget } from './focus';
import { stepItems, stepSummary } from './steps';
import { TOAST_DURATION_MS, toastReducer } from './toastState';
import { MEDIA } from './media';
import { ICON_NAMES, Icon } from './Icon';

const SOLANA = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const EVM = '0x1111111111111111111111111111111111111111';

test('a full address is split for display without dropping a character', () => {
  for (const address of [SOLANA, EVM]) {
    const parts = splitAddress(address);
    assert.equal(parts.head + parts.middle + parts.tail, address);
    assert.equal(parts.head, address.slice(0, 6));
    assert.equal(parts.tail, address.slice(-6));
  }
  assert.deepEqual(splitAddress('ABCDEFGHIJKL'), { head: 'ABCDEFGHIJKL', middle: '', tail: '' });
  assert.deepEqual(splitAddress('  ABCDEFGHIJKLM  '), { head: 'ABCDEF', middle: 'G', tail: 'HIJKLM' });
});

test('the short form matches the shell (first 6, last 5) and leaves short strings whole', () => {
  assert.equal(shortAddress(SOLANA), 'AKnL4N…aRSZ9');
  assert.equal(shortAddress(EVM), '0x1111…11111');
  assert.equal(shortAddress('0123456789abcdef'), '0123456789abcdef');
});

test('copying never throws and reports a missing or refusing clipboard', async () => {
  const written: string[] = [];
  assert.equal(await copyText(SOLANA, { writeText: async text => { written.push(text); } }), 'copied');
  assert.deepEqual(written, [SOLANA]);
  assert.equal(await copyText(SOLANA, { writeText: async () => { throw new Error('denied'); } }), 'unavailable');
  assert.equal(await copyText(SOLANA, undefined), 'unavailable');
  assert.equal(COPY_MESSAGES.copied, 'Address copied.');
  assert.equal(COPY_MESSAGES.unavailable, 'Clipboard unavailable. Select and copy the address.');
});

test('the focus trap wraps at both ends and pulls stray focus back in', () => {
  assert.equal(trapTarget(0, -1, false), -1);
  assert.equal(trapTarget(0, -1, true), -1);
  assert.equal(trapTarget(3, 2, false), 0);
  assert.equal(trapTarget(3, 0, true), 2);
  assert.equal(trapTarget(3, -1, false), 0);
  assert.equal(trapTarget(3, -1, true), 2);
  assert.equal(trapTarget(3, 1, false), null);
  assert.equal(trapTarget(3, 1, true), null);
  for (const selector of ['button:not(:disabled)', 'input:not(:disabled)', 'select:not(:disabled)', 'a[href]']) assert.ok(FOCUSABLE.includes(selector));
  assert.ok(!FOCUSABLE.includes('[tabindex="-1"],'));
});

test('only the most recent sheet is on top, and closing any sheet restores the order', () => {
  const stack = createModalStack();
  assert.equal(stack.top(), null);
  stack.push('send');
  stack.push('picker');
  stack.push('picker');
  assert.equal(stack.size(), 2);
  assert.ok(stack.isTop('picker') && !stack.isTop('send') && stack.has('send'));
  stack.remove('send');
  assert.equal(stack.top(), 'picker');
  stack.remove('picker');
  stack.remove('missing');
  assert.equal(stack.size(), 0);
  assert.ok(!stack.has('picker'));
});

test('step states follow the active step and never run ahead of it', () => {
  const steps = ['Asset', 'Details', 'Review', 'Result'];
  assert.deepEqual(stepItems(steps, 1).map(item => item.status), ['complete', 'current', 'upcoming', 'upcoming']);
  assert.deepEqual(stepItems(steps, 0).map(item => item.status), ['current', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(stepItems(steps, 4).map(item => item.status), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(stepItems(steps, 99).map(item => item.status), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(stepItems(steps, -3).map(item => item.status), ['current', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(stepItems(steps, Number.NaN).map(item => item.status), ['current', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(stepItems(steps, 2).map(item => item.number), [1, 2, 3, 4]);
  assert.equal(stepSummary(steps), '1 Asset · 2 Details · 3 Review · 4 Result');
});

test('one toast at a time: a new message replaces the old one and a late timer cannot dismiss it', () => {
  assert.equal(TOAST_DURATION_MS, 4_500);
  const first = toastReducer(null, { type: 'show', message: 'Address copied.' });
  assert.deepEqual(first, { id: 1, message: 'Address copied.' });
  const second = toastReducer(first, { type: 'show', message: 'Address copied.' });
  assert.deepEqual(second, { id: 2, message: 'Address copied.' });
  assert.equal(toastReducer(second, { type: 'dismiss', id: 1 }), second);
  assert.equal(toastReducer(second, { type: 'dismiss', id: 2 }), null);
  assert.equal(toastReducer(second, { type: 'dismiss' }), null);
  assert.equal(toastReducer(second, { type: 'show', message: '   ' }), second);
});

test('art slots use only ANTARA media that exists, never the retired src/assets art', () => {
  for (const path of Object.values(MEDIA)) {
    assert.doesNotMatch(path, /src\/assets|\/assets\//);
    if (path.startsWith('/antara/')) {
      assert.ok(existsSync(new URL(`../../../public${path}`, import.meta.url)), path);
    } else {
      // A bundled rendition (imported, so the extension carries it): ANTARA's own docs art.
      assert.match(path, /^[\w-]+\.webp$/, path);
      assert.ok(existsSync(new URL(`../docs/art/${path}`, import.meta.url)), path);
    }
  }
});

test('icons keep the shell set and add the six functional icons, always hidden from assistive technology', () => {
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  for (const name of ['qr', 'book', 'shield', 'release', 'deposit', 'back', 'copy', 'close', 'check'] as const) assert.ok(ICON_NAMES.includes(name));
  for (const name of ICON_NAMES) {
    const markup = renderToStaticMarkup(createElement(Icon, { name }));
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /stroke-width="1.6"/);
    assert.match(markup, /viewBox="0 0 24 24"/);
    assert.match(markup, /<(path|rect|circle|ellipse)/, name);
  }
});

test('tokens match the design system table and stay off :root', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const expected: Record<string, string> = {
    '--ink-0': '#030303', '--ink-1': '#08090b', '--surface-1': '#101216', '--surface-2': '#131519', '--surface-3': '#191b20',
    '--line': '#ffffff14', '--hair': '#ffffff0d', '--fg': '#eaf1ff', '--fg-2': '#c9d2df', '--muted': '#9aa5b6', '--faint': '#6f7a8a',
    '--accent': '#9cbfff', '--accent-tint': '#a9c6ff12', '--primary-bg': '#c3d5f1', '--primary-fg': '#142038', '--primary-hover': '#d8e5fb',
    '--focus': '#86afff', '--ice': '#c4e5ff', '--warn': '#e9c07a', '--danger': '#ff8f86', '--switch-on': '#3867df',
    '--r-xs': '6px', '--r-sm': '10px', '--r-md': '14px', '--r-lg': '20px', '--r-pill': '999px', '--antara-body': 'var(--font-ui)',
  };
  for (const [name, value] of Object.entries(expected)) assert.match(css, new RegExp(`${name}:\\s*${value.replace(/[()]/g, '\\$&')};`), name);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /(^|[\s,{}]):root\b/);
  const ui = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
  // The only primary style is the ice one; no gradient anywhere in the shared components.
  assert.match(ui, /\.ui-btn-primary \{ background: var\(--primary-bg\)/);
  assert.doesNotMatch(ui, /gradient\(/);
  // Every selector in the shared stylesheet is ui- prefixed (or the tokens' own scopes and keyframes).
  const selectors = ui.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|[{}])\s*([^@{}\s][^{}]*)\{/g) ?? [];
  assert.ok(selectors.length > 40);
  for (const block of selectors) {
    const selector = block.replace(/^[{}\s]+/, '').replace(/\{$/, '').trim();
    if (/^(from|to|\d+%)$/.test(selector)) continue;
    assert.match(selector, /\.ui-|html\[data-motion|\[data-motion|\[data-window-hidden/, selector);
  }
});
