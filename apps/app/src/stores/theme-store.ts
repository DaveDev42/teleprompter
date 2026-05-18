import { Appearance, Platform } from "react-native";
import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export type Theme = "dark" | "light" | "system";

export interface ThemeStore {
  theme: Theme;
  /** Resolved: what's actually applied */
  isDark: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
}

const STORAGE_KEY = "app_theme";

function resolveIsDark(theme: Theme): boolean {
  if (theme === "system") {
    return Appearance.getColorScheme() !== "light";
  }
  return theme === "dark";
}

// Synchronous read on web so the store's initial state matches the value
// already stamped on <html> by app/+html.tsx's inline bootstrap. Without
// this, the first render flickers (e.g. stored="light" but OS prefers
// dark would briefly flip to dark before async load() resolves).
function readInitialTheme(): Theme {
  if (Platform.OS !== "web") return "system";
  try {
    const raw = localStorage.getItem(`tp_${STORAGE_KEY}`);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    // localStorage may throw in private mode / locked-down browsers
  }
  return "system";
}

const initialTheme = readInitialTheme();

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: initialTheme,
  isDark: resolveIsDark(initialTheme),
  loaded: false,

  load: async () => {
    try {
      const raw = await secureGet(STORAGE_KEY);
      if (raw === "dark" || raw === "light" || raw === "system") {
        set({ theme: raw, isDark: resolveIsDark(raw), loaded: true });
        return;
      }
    } catch {
      // ignore
    }
    set({ loaded: true });
  },

  setTheme: async (theme) => {
    set({ theme, isDark: resolveIsDark(theme) });
    await secureSet(STORAGE_KEY, theme);
  },
}));
