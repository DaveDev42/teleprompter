import { Platform } from "react-native";

const FOCUS_CLASS = "focus-visible:ring-2 focus-visible:ring-tp-border-focus focus-visible:outline-none";

export function usePlatformProps(options?: {
  focusable?: boolean;
  tabIndex?: number;
}): { tabIndex?: number; className?: string } {
  if (Platform.OS !== "web") return {};

  const focusable = options?.focusable ?? true;
  if (!focusable) return {};

  return {
    tabIndex: options?.tabIndex ?? 0,
    className: FOCUS_CLASS,
  };
}
