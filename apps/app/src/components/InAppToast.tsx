import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
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

  // RN Web's createDOMProps strips `aria-atomic` when spread on a <View>
  // (only a curated allowlist of aria-* attrs round-trips). Set it on the
  // underlying DOM node imperatively so screen readers receive the full
  // announcement on every update.
  const liveRegionRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = liveRegionRef.current as unknown as HTMLElement | null;
    if (el) el.setAttribute("aria-atomic", "true");
  }, []);

  const handlePress = () => {
    if (!toast) return;
    dismiss();
    if (toast.data?.sid) {
      router.push(`/session/${toast.data.sid}`);
    }
  };

  // role=status has implicit aria-live=polite + aria-atomic=true per ARIA
  // 1.2, but NVDA/JAWS historically (still in some versions) ignore the
  // implicit aria-atomic and read only the diff when toast text changes —
  // the user hears the new chars without context. Set aria-atomic=true
  // explicitly (via the imperative liveRegionRef effect above) so the
  // whole region is announced as one unit on every update. We used to set
  // role=alert (implicit aria-live=assertive) AND aria-live=polite, which
  // conflict — screen readers got mixed signals about urgency. The toast
  // is a non-critical notification (Claude session events), so polite is
  // right. Spread role/aria-live on web only; native still relies on
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
      ref={liveRegionRef}
      testID="toast-live-region"
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
            {/*
              The dismiss button already exposes its accessible name via
              accessibilityLabel="Dismiss notification" on the parent
              Pressable. But role=status computes its announcement text
              from raw DOM textContent (not from descendant accessible
              names), so the bare "✕" glyph is appended to every toast
              announcement — NVDA/JAWS read "Paired daemon-abc connected.
              ✕". Hide the decorative glyph from AT on web so the live
              region only announces the toast title + body. Native AT
              focuses the parent Pressable and reads its accessibilityLabel,
              so the gate is web-only. WCAG 1.1.1 + 4.1.3.
            */}
            <Text
              className="text-tp-text-tertiary text-lg"
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            >
              ✕
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
