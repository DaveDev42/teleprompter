/**
 * Shared focusable-element discovery for web-only focus management.
 * Single source for the selector that ModalContainer's focus trap and the
 * gamepad navigation bridge both use — keeping them identical means a
 * control reachable by Tab inside a dialog is exactly the set reachable
 * by D-pad.
 */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Focusable elements under `root` that a user can actually reach: not
 * disabled and currently rendered. Visibility uses getClientRects() (empty
 * for display:none subtrees) rather than offsetParent, which is also null
 * for position:fixed elements like toasts and floating bars.
 */
export function getVisibleFocusables(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) =>
      !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
}
