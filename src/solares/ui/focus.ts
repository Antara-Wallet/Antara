/** Pure focus-trap and modal-stack logic behind Sheet (docs/UI_ARGUS_PARITY.md 4.4). */

/** Elements a keyboard user can reach inside a sheet. */
export const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/**
 * Where Tab should go inside a trap of `count` focusable items when focus is at `index`
 * (-1: the sheet itself or anywhere outside it). Returns the index to focus, -1 to keep
 * focus on the sheet itself (nothing focusable), or null to let the browser move normally.
 */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (shift) return index <= 0 ? count - 1 : null;
  return index === -1 || index >= count - 1 ? 0 : null;
}

/** Open modals, bottom to top. Only the top one answers Escape and Tab. */
export interface ModalStack {
  push(id: string): void;
  remove(id: string): void;
  top(): string | null;
  isTop(id: string): boolean;
  has(id: string): boolean;
  size(): number;
}

export function createModalStack(): ModalStack {
  const ids: string[] = [];
  return {
    push(id) { if (!ids.includes(id)) ids.push(id); },
    remove(id) { const index = ids.indexOf(id); if (index !== -1) ids.splice(index, 1); },
    top: () => ids[ids.length - 1] ?? null,
    isTop: id => ids[ids.length - 1] === id,
    has: id => ids.includes(id),
    size: () => ids.length,
  };
}
