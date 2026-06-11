import { useEffect } from "react";
import { Platform } from "react-native";
import { isAnyModalOpen } from "../lib/modal-open-registry";
import { isShortcutEligible } from "../lib/shortcut-guards";

type ShortcutMap = Record<string, () => void>;

/**
 * Single-key global shortcuts for Web. No-op on native — hardware-keyboard
 * support on iPad would go through UIKeyCommand, not DOM events.
 *
 * Deliberately different from useKeyboard (which exists for must-fire keys
 * like Escape in modals): a shortcut here only activates when the keystroke
 * could not mean anything else —
 * - never when a modifier (ctrl/meta/alt) is held, so browser/OS chords are
 *   not shadowed (shift is allowed: "?" needs it)
 * - never while focus is in an editable element or inside a
 *   [data-shortcuts-disabled] container (the ghostty terminal)
 * - never while a ModalContainer dialog is open — `inert` does not block
 *   capture-phase document listeners
 * - never on key auto-repeat or an event something else already handled
 *
 * Uses the capture phase for the same reason useKeyboard does: RN Web's
 * TextInput stops propagation of every keydown, and the editable-target
 * guard (not propagation) is what protects inputs here.
 *
 * Build the keyMap with useMemo — it is an effect dependency.
 */
export function useGlobalShortcuts(keyMap: ShortcutMap): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const handler = (e: KeyboardEvent) => {
      const fn = keyMap[e.key];
      if (!fn) return;
      if (!isShortcutEligible(e)) return;
      if (isAnyModalOpen()) return;
      e.preventDefault();
      fn();
    };

    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [keyMap]);
}
