import { create } from "zustand";
import { Appearance } from "react-native";

export type Theme = "dark" | "light" | "system";

export interface ThemeStore {
  theme: Theme;
  /** Resolved: what's actually applied */
  isDark: boolean;
  setTheme: (theme: Theme) => void;
}

function resolveIsDark(theme: Theme): boolean {
  if (theme === "system") {
    return Appearance.getColorScheme() !== "light";
  }
  return theme === "dark";
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: "dark",
  isDark: true,
  setTheme: (theme) => set({ theme, isDark: resolveIsDark(theme) }),
}));
