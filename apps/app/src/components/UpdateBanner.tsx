import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OtaStatus } from "../hooks/use-ota-update";

export function UpdateBanner({
  status,
  onRestart,
}: {
  status: OtaStatus;
  onRestart: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);

  if (status !== "ready" || dismissed) return null;

  return (
    <View
      className="absolute left-0 right-0 z-50 px-4"
      style={{ top: insets.top + 8 }}
    >
      <Pressable
        onPress={onRestart}
        accessibilityRole="button"
        accessibilityLabel="Update available, tap to restart"
        className="flex-row bg-tp-surface border border-tp-border rounded-card overflow-hidden"
      >
        {/* Blue accent bar */}
        <View className="w-[3px] bg-tp-accent" />

        <View className="flex-1 px-4 py-3">
          <Text className="text-tp-text-primary text-[15px] font-semibold">
            Update Available
          </Text>
          <Text className="text-tp-text-secondary text-[13px] mt-0.5">
            A new version is ready. Tap to restart.
          </Text>
        </View>

        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            setDismissed(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss update banner"
          className="px-3 justify-center"
          hitSlop={8}
        >
          <Text className="text-tp-text-tertiary text-[13px]">✕</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}
