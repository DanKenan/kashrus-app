import { writesInFlight } from './api';

/**
 * Is it safe to switch to a new version (and reload) right now? Used only by
 * the "Tap to update" bar (lib/swUpdate.ts applyUpdate). A switch waits while:
 *  - saving: a write to the server has not answered yet;
 *  - typing: someone is in a text field or a list (it has the keyboard focus);
 *  - open: a form, sheet or dialog is open (every one of the app's is a
 *    full-screen `fixed inset-0` layer, or marks itself with role="dialog",
 *    aria-modal or data-modal).
 * Anything else that holds unsaved work keeps the 428 draft safety net.
 */
export type UpdateBlockReason = 'saving' | 'typing' | 'open';

const OPEN_LAYER = '.fixed.inset-0, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-modal]';

export function updateBlockedReason(): UpdateBlockReason | null {
  if (writesInFlight() > 0) return 'saving';
  if (typeof document === 'undefined') return null;
  const el = document.activeElement as HTMLElement | null;
  if (el && !el.closest?.('[data-update-banner]')) {
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.getAttribute?.('type') || '').toLowerCase();
    const textInput = tag === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
    if (textInput || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return 'typing';
  }
  const layers = Array.from(document.querySelectorAll(OPEN_LAYER) as ArrayLike<Element>);
  if (layers.some((l) => !l.closest?.('[data-update-banner]'))) return 'open';
  return null;
}
