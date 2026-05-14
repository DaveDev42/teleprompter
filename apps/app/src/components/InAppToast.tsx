import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNotificationStore } from "../stores/notification-store";

export function InAppToast() {
  const toast = useNotificationStore((s) => s.toast);
  const dismiss = useNotificationStore((s) => s.dismissToast);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  if (!toast) return null;

  const handlePress = () => {
    dismiss();
    if (toast.data?.sid) {
      router.push(`/session/${toast.data.sid}`);
    }
  };

  // Outer View carries role=alert so screen readers announce the toast
  // contents on appearance. The body and dismiss buttons are independent
  // children — ARIA disallows merging role=alert with a clickable
  // role=button on the same element, which previously hid the actionable
  // nature of the toast from assistive tech.
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="absolute left-4 right-4 bg-tp-bg-elevated rounded-card border border-tp-border shadow-lg z-50"
      style={{ top: insets.top + 8 }}
    >
      <View className="flex-row items-center justify-between">
        <Pressable
          onPress={handlePress}
          accessibilityRole="button"
          accessibilityLabel={`Open: ${toast.title}: ${toast.body}`}
          className="flex-1 p-4"
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
          className="px-4 py-4"
        >
          <Text className="text-tp-text-tertiary text-lg">✕</Text>
        </Pressable>
      </View>
    </View>
  );
}
