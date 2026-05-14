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

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${toast.title}: ${toast.body}`}
      className="absolute left-4 right-4 bg-tp-bg-elevated rounded-card border border-tp-border p-4 shadow-lg z-50"
      style={{ top: insets.top + 8 }}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 mr-2">
          <Text className="text-tp-text-primary font-semibold text-sm">
            {toast.title}
          </Text>
          <Text className="text-tp-text-secondary text-sm mt-1">
            {toast.body}
          </Text>
        </View>
        <Pressable
          onPress={(e) => {
            // Without stopPropagation, the outer alert Pressable's onPress
            // also fires — dismissing the toast AND navigating to the
            // session. Match the pattern UpdateBanner already uses.
            e.stopPropagation();
            dismiss();
          }}
          hitSlop={8}
          accessibilityLabel="Dismiss notification"
          accessibilityRole="button"
        >
          <Text className="text-tp-text-tertiary text-lg">✕</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}
