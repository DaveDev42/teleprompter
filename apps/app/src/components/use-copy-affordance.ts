import { Platform } from "react-native";
import { copyText } from "../lib/copy-text";

/**
 * Returns Pressable props that wire up a keyboard-accessible copy affordance
 * for chat bubbles rendered with role="group".
 *
 * Background: RN Web's PressResponder only treats Space as an activation key
 * when the target carries role="button" (isButtonRole check). role="group"
 * misses that branch, so Space lands silently even though Enter activates
 * onPress. WCAG 2.1.1 expects the copy affordance to be reachable via the
 * standard activation keys — this hook wires the Space handler explicitly and
 * provides the matching web a11y props.
 */
export function useCopyAffordance(text: string): {
  onPress?: () => void;
  onLongPress: () => void;
  onKeyDown?: (e: { key: string; preventDefault: () => void }) => void;
  webGroupProps: object;
  accessibilityHint: string;
} {
  const isWeb = Platform.OS === "web";

  const onPress = isWeb ? () => copyText(text) : undefined;
  const onLongPress = () => copyText(text);

  const onKeyDown = isWeb
    ? (e: { key: string; preventDefault: () => void }) => {
        if (e.key === " ") {
          e.preventDefault();
          copyText(text);
        }
      }
    : undefined;

  const webGroupProps = isWeb
    ? ({
        role: "group",
        "aria-description": "Press Enter or Space to copy",
      } as object)
    : {};

  return {
    onPress,
    onLongPress,
    onKeyDown,
    webGroupProps,
    accessibilityHint: "Long press to copy",
  };
}
