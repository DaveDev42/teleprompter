import { useEffect } from "react";
import { Platform } from "react-native";

type KeyMap = Record<string, () => void>;

/**
 * Global keyboard event handler for Web. No-op on native.
 * NOTE: Calls e.preventDefault() for every matched key.
 * Only use for keys that should be globally intercepted (e.g., Escape in modals).
 * For form-level keys (Enter, Space), use component-level onKeyDown instead.
 *
 * Uses capture phase because react-native-web's TextInput calls
 * `e.stopPropagation()` on every keydown — without capture, Escape pressed
 * while focused inside a TextInput never bubbles up to close the modal.
 */
export function useKeyboard(keyMap: KeyMap): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const handler = (e: KeyboardEvent) => {
      const fn = keyMap[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };

    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [keyMap]);
}
