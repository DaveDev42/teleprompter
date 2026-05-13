import { Appearance } from "react-native";
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

export const useThemeStore = create<ThemeStore>((set) => ({
  // Default to "system" so first-time visitors on a light-mode OS don't
  // get force-flipped to dark before `load()` resolves. Existing users
  // with a stored preference keep their choice via `load()`.
  theme: "system",
  isDark: resolveIsDark("system"),
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
