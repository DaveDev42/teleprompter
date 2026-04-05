import { Platform } from "react-native";

const FOCUS_CLASS = "focus-visible:ring-2 focus-visible:ring-tp-border-focus focus-visible:outline-none";

export function getPlatformProps(options?: {
  focusable?: boolean;
  tabIndex?: 0 | -1;
}): { tabIndex?: 0 | -1; className: string } {
  if (Platform.OS !== "web") return { className: "" };

  const focusable = options?.focusable ?? true;
  if (!focusable) return { className: "" };

  return {
    tabIndex: options?.tabIndex ?? 0,
    className: FOCUS_CLASS,
  };
}
