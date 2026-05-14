import { useRouter } from "expo-router";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getPlatformProps } from "../lib/get-platform-props";
import { useNotificationStore } from "../stores/notification-store";

export function InAppToast() {
  const toast = useNotificationStore((s) => s.toast);
  const dismiss = useNotificationStore((s) => s.dismissToast);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const pp = getPlatformProps();

  const handlePress = () => {
    if (!toast) return;
    dismiss();
    if (toast.data?.sid) {
      router.push(`/session/${toast.data.sid}`);
    }
  };

  // role=status is implicit aria-live=polite + aria-atomic=true. We used to
  // set role=alert (implicit aria-live=assertive) AND aria-live=polite, which
  // conflict — screen readers got mixed signals about urgency. The toast is
  // a non-critical notification (Claude session events), so polite is right.
  // Spread role/aria-live on web only; native still relies on
  // accessibilityLiveRegion which RN translates to TalkBack/VoiceOver.
  //
  // Keep the live region mounted at all times. NVDA/JAWS won't announce
  // updates to regions that were inserted into the DOM after page load —
  // ARIA19/APG live-region patterns require the container to exist before
  // any content is added. While empty, only the chrome styling is
  // suppressed so the region stays in the accessibility tree (display:none
  // removes it from a11y tree, defeating the purpose). pointerEvents=none
  // keeps the empty placeholder from blocking touches behind it.
  return (
    <View
      accessibilityLiveRegion="polite"
      {...((Platform.OS === "web"
        ? { role: "status", "aria-live": "polite" }
        : {}) as object)}
      pointerEvents={toast ? "auto" : "none"}
      className={
        toast
          ? "absolute left-4 right-4 bg-tp-bg-elevated rounded-card border border-tp-border shadow-lg z-50"
          : "absolute left-4 right-4 z-50"
      }
      style={{ top: insets.top + 8 }}
    >
      {toast ? (
        <View className="flex-row items-center justify-between">
          <Pressable
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityLabel={`Open: ${toast.title}: ${toast.body}`}
            tabIndex={pp.tabIndex}
            className={`flex-1 p-4 ${pp.className}`}
          >
            <Text className="text-tp-text-primary font-semibold text-sm">
              {toast.title}
            </Text>
            <Text className="text-tp-text-secondary text-sm mt-1">
              {toast.body}
            </Text>
          </Pressable>
          <Pressable
            onPress={dismiss}
            hitSlop={8}
            accessibilityLabel="Dismiss notification"
            accessibilityRole="button"
            tabIndex={pp.tabIndex}
            className={`px-4 py-4 ${pp.className}`}
          >
            <Text className="text-tp-text-tertiary text-lg">✕</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
