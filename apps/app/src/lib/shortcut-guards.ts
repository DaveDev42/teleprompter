/**
 * Pure guard logic for global single-key shortcuts (see
 * hooks/use-global-shortcuts.ts). Kept DOM-free — targets are duck-typed —
 * so the rules are unit-testable under bun:test, which has no
 * document/Element globals.
 */

/**
 * Containers that must swallow raw keystrokes (e.g. the ghostty terminal,
 * whose a11y mirror div is focusable but not editable) opt out of global
 * shortcuts by carrying this attribute. Checked via Element.closest so the
 * attribute covers everything focusable inside.
 */
export const SHORTCUTS_DISABLED_ATTR = "data-shortcuts-disabled";

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: (selector: string) => unknown;
}

/**
 * True when keystrokes on `target` belong to the target itself — text
 * inputs, contenteditable surfaces, or anything inside an opted-out
 * container — and must never trigger a global shortcut.
 */
export function isShortcutOptOutTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as ElementLike;
  if (typeof el.tagName === "string" && EDITABLE_TAGS.has(el.tagName)) {
    return true;
  }
  if (el.isContentEditable === true) return true;
  if (
    typeof el.closest === "function" &&
    el.closest(`[${SHORTCUTS_DISABLED_ATTR}]`)
  ) {
    return true;
  }
  return false;
}

/** The subset of KeyboardEvent the eligibility rules read. */
export interface ShortcutKeyEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

/**
 * Whether a keydown may activate a global single-key shortcut.
 * Modifier chords (ctrl/meta/alt) are always passed through so browser and
 * OS shortcuts are never shadowed — shift is deliberately allowed because
 * "?" requires it on most layouts. Auto-repeat is ignored so a held key
 * can't spam navigation.
 */
export function isShortcutEligible(e: ShortcutKeyEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.repeat) return false;
  if (isShortcutOptOutTarget(e.target)) return false;
  return true;
}
