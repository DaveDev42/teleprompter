import { useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";

// Duration the transient "Reconnected" confirmation stays visible after the
// relay link is restored. Short enough that it doesn't linger as visual
// noise, long enough that AT polite-queue flushers reliably announce it.
const RECONNECT_BANNER_MS = 2500;

// Persistent connection-state live region. Mounted for the lifetime of an
// active session so a screen reader can announce both the loss of
// connectivity and its recovery — if the disconnected banner was
// conditionally mounted on !connected and unmounted on reconnect, AT would
// hear "Disconnected..." but nothing on recovery, leaving users uncertain
// whether their pending messages went out. Wrapper is always in the tree;
// the chrome is only rendered when the message slot is non-empty so the
// header layout collapses to zero rows during steady-state.
export function ConnectionLiveRegion({ connected }: { connected: boolean }) {
  const [message, setMessage] = useState<"" | "disconnected" | "reconnected">(
    "",
  );
  // Track whether we've seen a disconnect so we don't fire a spurious
  // "Reconnected" on initial mount (connected starts true on a healthy
  // session — announcing recovery for a state that was never lost is noise).
  const hasBeenDisconnected = useRef(false);

  useEffect(() => {
    if (!connected) {
      hasBeenDisconnected.current = true;
      setMessage("disconnected");
      return;
    }
    // connected === true
    if (!hasBeenDisconnected.current) {
      setMessage("");
      return;
    }
    setMessage("reconnected");
    const t = setTimeout(() => setMessage(""), RECONNECT_BANNER_MS);
    return () => clearTimeout(t);
  }, [connected]);

  // role=status implies aria-atomic=true per ARIA 1.2, but NVDA/JAWS in
  // some shipped versions ignore the implicit value and read only the
  // text diff between updates — the user hears the new word ("Reconnected")
  // without the surrounding context. RN Web 0.21's createDOMProps also
  // strips `aria-atomic` when spread on a <View>, so the explicit prop
  // never lands. Mirror the InAppToast imperative escape hatch: set
  // aria-atomic on the underlying DOM node so the whole label is
  // announced as one unit on every update.
  const liveRegionRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = liveRegionRef.current as unknown as HTMLElement | null;
    if (el) el.setAttribute("aria-atomic", "true");
  }, []);

  // Render the wrapper unconditionally so AT keeps a stable live region
  // attached. The visible chrome is the only thing that toggles.
  return (
    <View
      ref={liveRegionRef}
      testID="session-connection-live-region"
      accessibilityLiveRegion="polite"
      accessibilityLabel={
        message === "disconnected"
          ? "Disconnected. Messages will send after reconnect."
          : message === "reconnected"
            ? "Reconnected."
            : undefined
      }
      {...(Platform.OS === "web" ? { role: "status" as const } : {})}
    >
      {message === "disconnected" && (
        <View
          testID="session-disconnected-banner"
          className="flex-row items-center px-4 py-2 bg-tp-bg-secondary border-b border-tp-border"
        >
          <View className="w-1.5 h-1.5 rounded-full bg-tp-text-tertiary mr-2" />
          <Text className="text-tp-text-secondary text-[12px] font-medium">
            Disconnected — messages will send after reconnect
          </Text>
        </View>
      )}
      {message === "reconnected" && (
        <View
          testID="session-reconnected-banner"
          className="flex-row items-center px-4 py-2 bg-tp-bg-secondary border-b border-tp-border"
        >
          <View className="w-1.5 h-1.5 rounded-full bg-tp-success mr-2" />
          <Text className="text-tp-text-secondary text-[12px] font-medium">
            Reconnected
          </Text>
        </View>
      )}
    </View>
  );
}
