import { useWindowDimensions } from "react-native";

export type LayoutMode = "mobile" | "tablet" | "desktop";

const TABLET_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1024;

export function useLayout(): {
  mode: LayoutMode;
  width: number;
  height: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
} {
  const { width, height } = useWindowDimensions();

  const mode: LayoutMode =
    width >= DESKTOP_BREAKPOINT
      ? "desktop"
      : width >= TABLET_BREAKPOINT
        ? "tablet"
        : "mobile";

  return {
    mode,
    width,
    height,
    isMobile: mode === "mobile",
    isTablet: mode === "tablet",
    isDesktop: mode === "desktop",
  };
}
