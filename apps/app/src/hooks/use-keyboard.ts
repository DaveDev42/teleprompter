import { useEffect } from "react";
import { Platform } from "react-native";

type KeyMap = Record<string, () => void>;

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

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [keyMap]);
}
