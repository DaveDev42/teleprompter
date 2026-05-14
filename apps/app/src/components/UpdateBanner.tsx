import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OtaStatus } from "../hooks/use-ota-update";
import { getPlatformProps } from "../lib/get-platform-props";

export function UpdateBanner({
  status,
  onRestart,
}: {
  status: OtaStatus;
  onRestart: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const pp = getPlatformProps();

  if (status !== "ready" || dismissed) return null;

  return (
    <View
      // role="alert" announces the banner when it appears so screen reader
      // users learn about the available update without sighted prompts.
      // RN's AccessibilityRole union excludes "alert", so spread on web only.
      // role="alert" carries an implicit `aria-live="assertive"` and
      // `aria-atomic="true"` — explicitly setting aria-live="polite" alongside
      // it downgrades the announcement and produces SR-implementation-
      // dependent behavior (some announce, some don't). Leave it implicit.
      className="absolute left-0 right-0 z-50 px-4"
      style={{ top: insets.top + 8 }}
      {...(Platform.OS === "web" ? { role: "alert" } : {})}
    >
      <Pressable
        onPress={onRestart}
        accessibilityRole="button"
        accessibilityLabel="Update available, tap to restart"
        tabIndex={pp.tabIndex}
        className={`flex-row bg-tp-surface border border-tp-border rounded-card overflow-hidden ${pp.className}`}
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
          tabIndex={pp.tabIndex}
          className={`px-3 justify-center ${pp.className}`}
          hitSlop={8}
        >
          <Text className="text-tp-text-tertiary text-[13px]">✕</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}
