import { useEffect, useRef } from "react";
import { Platform, Text, View } from "react-native";

// Same always-mounted live region pattern as ConnectionLiveRegion:
// wrapper stays attached so AT observes the text insertion when the
// session flips from running to stopped. Without this, mounting the
// banner together with its content drops the first announcement —
// the observer is attached at insertion time, not at content-change
// time, so a node that appears with content is observed too late.
export function SessionStoppedLiveRegion({ stopped }: { stopped: boolean }) {
  // role=status implies aria-atomic=true per ARIA 1.2, but NVDA/JAWS
  // and RN Web 0.21 both have gaps — mirror the imperative escape
  // hatch from ConnectionLiveRegion / InAppToast.
  const liveRegionRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = liveRegionRef.current as unknown as HTMLElement | null;
    if (el) el.setAttribute("aria-atomic", "true");
  }, []);

  return (
    <View
      ref={liveRegionRef}
      testID="session-stopped-banner"
      accessibilityLiveRegion="polite"
      accessibilityLabel={
        stopped ? "Session ended. Read-only view." : undefined
      }
      {...(Platform.OS === "web" ? { role: "status" as const } : {})}
    >
      {stopped && (
        <View
          testID="session-stopped-banner-chrome"
          className="flex-row items-center px-4 py-2 bg-tp-bg-secondary border-b border-tp-border"
        >
          <View className="w-1.5 h-1.5 rounded-full bg-tp-warning mr-2" />
          <Text className="text-tp-text-secondary text-[12px] font-medium">
            Session ended — read-only view
          </Text>
        </View>
      )}
    </View>
  );
}
