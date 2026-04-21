/**
 * JS-accessible mirror of the `tp-*` semantic tokens declared in
 * `apps/app/global.css`. React Native components that cannot consume
 * NativeWind class names directly (Expo Router `tabBarStyle`, Ghostty
 * renderer palette, etc.) read these constants instead of hardcoding hex
 * literals. Keep in sync with `:root` / `.dark` in `global.css`.
 */

export interface PaletteTokens {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  bgElevated: string;
  bgInput: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderSubtle: string;
  borderFocus: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnColor: string;
  accent: string;
  accentHover: string;
}

export const LIGHT_TOKENS: PaletteTokens = {
  bg: "#ffffff",
  bgSecondary: "#f4f4f5",
  bgTertiary: "#e4e4e7",
  bgElevated: "#ffffff",
  bgInput: "#f4f4f5",
  surface: "#ffffff",
  surfaceHover: "#f4f4f5",
  border: "#e4e4e7",
  borderSubtle: "#f4f4f5",
  borderFocus: "#3b82f6",
  textPrimary: "#09090b",
  textSecondary: "#71717a",
  textTertiary: "#a1a1aa",
  textOnColor: "#ffffff",
  accent: "#2563eb",
  accentHover: "#1d4ed8",
};

export const DARK_TOKENS: PaletteTokens = {
  bg: "#09090b",
  bgSecondary: "#18181b",
  bgTertiary: "#27272a",
  bgElevated: "#1c1c1f",
  bgInput: "#27272a",
  surface: "#18181b",
  surfaceHover: "#27272a",
  border: "#27272a",
  borderSubtle: "#1f1f23",
  borderFocus: "#3b82f6",
  textPrimary: "#fafafa",
  textSecondary: "#a1a1aa",
  textTertiary: "#71717a",
  textOnColor: "#ffffff",
  accent: "#3b82f6",
  accentHover: "#2563eb",
};

export function getPalette(isDark: boolean): PaletteTokens {
  return isDark ? DARK_TOKENS : LIGHT_TOKENS;
}

/**
 * Terminal renderer palette. Lives outside the semantic `tp-*` tokens
 * because the terminal is a fixed xterm-style surface: it does not follow
 * the light/dark system theme (`#000` background regardless), and it would
 * be wrong for the terminal cursor to pick up, say, `tp-text-primary` from
 * light mode. Centralised here so components don't rehardcode hex.
 */
export const TERMINAL_COLORS = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
} as const;
