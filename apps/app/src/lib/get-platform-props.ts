import { Platform } from "react-native";

const FOCUS_CLASS =
  "focus-visible:ring-2 focus-visible:ring-tp-border-focus focus-visible:outline-none";

const DEFAULT_PROPS = {
  tabIndex: 0 as const,
  className: FOCUS_CLASS,
};

const EMPTY_PROPS = { className: "" };
// Pressable on RN Web defaults tabIndex to 0 when undefined, so a display-only
// row still catches Tab. Explicitly setting -1 keeps it out of the tab order.
const NON_FOCUSABLE_PROPS = { className: "", tabIndex: -1 as const };

export function getPlatformProps(options?: {
  focusable?: boolean;
  tabIndex?: 0 | -1;
}): { tabIndex?: 0 | -1; className: string } {
  if (Platform.OS !== "web") return EMPTY_PROPS;

  const focusable = options?.focusable ?? true;
  if (!focusable) return NON_FOCUSABLE_PROPS;

  if (options?.tabIndex !== undefined) {
    return { tabIndex: options.tabIndex, className: FOCUS_CLASS };
  }

  return DEFAULT_PROPS;
}
