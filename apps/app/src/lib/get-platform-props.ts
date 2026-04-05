import { Platform } from "react-native";

const FOCUS_CLASS =
  "focus-visible:ring-2 focus-visible:ring-tp-border-focus focus-visible:outline-none";

const DEFAULT_PROPS = {
  tabIndex: 0 as const,
  className: FOCUS_CLASS,
};

const EMPTY_PROPS = { className: "" };

export function getPlatformProps(options?: {
  focusable?: boolean;
  tabIndex?: 0 | -1;
}): { tabIndex?: 0 | -1; className: string } {
  if (Platform.OS !== "web") return EMPTY_PROPS;

  const focusable = options?.focusable ?? true;
  if (!focusable) return EMPTY_PROPS;

  if (options?.tabIndex !== undefined) {
    return { tabIndex: options.tabIndex, className: FOCUS_CLASS };
  }

  return DEFAULT_PROPS;
}
