import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionLiveRegion } from "../../src/components/ConnectionLiveRegion";
import { SessionChatView } from "../../src/components/SessionChatView";
import {
  SESSION_TAB_CHAT_ID,
  SESSION_TAB_TERMINAL_ID,
  SESSION_TABPANEL_CHAT_ID,
  SESSION_TABPANEL_TERMINAL_ID,
  SessionSegmentedControl,
  type ViewMode,
} from "../../src/components/SessionSegmentedControl";
import { SessionStoppedLiveRegion } from "../../src/components/SessionStoppedLiveRegion";
import { SessionTerminalView } from "../../src/components/SessionTerminalView";
import { useAnyRelayConnected } from "../../src/hooks/use-relay";
import { getTransport } from "../../src/hooks/use-transport";
import { getPlatformProps } from "../../src/lib/get-platform-props";
import { isSessionRunning, isSessionStopped } from "../../src/lib/session-ux";
import { useChatStore } from "../../src/stores/chat-store";
import { useSessionStore } from "../../src/stores/session-store";

export default function SessionDetailScreen() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const [mode, setMode] = useState<ViewMode>("chat");
  const pp = getPlatformProps();
  const connected = useAnyRelayConnected();

  // RN Web's createDOMProps doesn't whitelist `hidden` on <View>, so
  // passing `hidden={mode !== "chat"}` to the tabpanel View silently
  // drops the attribute — the inactive tabpanel stays in layout and
  // remains in the AT tree. APG Tabs §3.23 requires the inactive
  // tabpanel to be removed from AT navigation; the canonical way is
  // the HTML `hidden` attribute. Mirror the imperative-setAttribute
  // pattern used elsewhere (ApiKeyModal aria-description, etc.) — set
  // it on the underlying DOM nodes after the mode flips so the panel
  // wrappers actually reflect the active tab.
  const chatPanelRef = useRef<View>(null);
  const terminalPanelRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const chatEl = chatPanelRef.current as unknown as HTMLElement | null;
    const terminalEl =
      terminalPanelRef.current as unknown as HTMLElement | null;
    if (chatEl) {
      if (mode === "chat") chatEl.removeAttribute("hidden");
      else chatEl.setAttribute("hidden", "");
    }
    if (terminalEl) {
      if (mode === "terminal") terminalEl.removeAttribute("hidden");
      else terminalEl.setAttribute("hidden", "");
    }
  }, [mode]);

  const session = sessions.find((s) => s.sid === sid);
  const stopped = isSessionStopped(session);
  const isRunning = isSessionRunning(session);

  // Attach to session on mount
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      client.attach(sid);
      setActiveSession({ active: true, sid });
    }
    // Clear chat and reset to chat tab for fresh state on session switch
    useChatStore.getState().clear();
    setMode("chat");

    return () => {
      const c = getTransport();
      if (c && sid) c.detach(sid);
    };
  }, [sid, setActiveSession]);

  // Derive display name from cwd. Strip a trailing slash first so a path like
  // "/Users/dave/proj/" yields "proj" rather than an empty string.
  const displayName =
    session?.cwd.replace(/\/+$/, "").split("/").pop() ?? sid ?? "Session";

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-tp-bg"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
      // WCAG 2.4.1 Bypass Blocks (Level A): expose the screen body as
      // the main landmark so AT users can jump straight to the chat /
      // terminal via landmark navigation. All other screens (/, /daemons,
      // /settings, /pairing, /pairing/scan) already do this; the session
      // detail view was missed.
      {...(Platform.OS === "web" ? { role: "main" as const } : {})}
    >
      {/* Safe area top */}
      <View className="bg-tp-bg-secondary" style={{ paddingTop: insets.top }} />

      {/* Nav header */}
      <View className="flex-row items-center px-2 py-2.5 bg-tp-bg-secondary border-b border-tp-border">
        <Pressable
          testID="session-back"
          // canGoBack() guards the case where the user opens /session/:sid
          // directly (deep link, browser refresh) — router.back() is a no-op
          // when there's no history entry, leaving the user stranded.
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/(tabs)/")
          }
          className={`px-2 ${pp.className}`}
          tabIndex={pp.tabIndex}
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
        >
          {/* The Back button's accessible name is set on the parent
              Pressable via accessibilityLabel. role=button is NOT
              atomic in NVDA browse mode / JAWS reading cursor — the
              virtual cursor descends into the child Text and announces
              "single left-pointing angle quotation mark Sessions"
              after the button's accessible name, doubling the
              announcement. Native AT focuses the parent Pressable and
              reads accessibilityLabel directly, so the gate is
              web-only. Same pattern as the chat send ↑ glyph fix.
              WCAG 1.1.1. */}
          <Text
            className="text-tp-accent text-base font-medium"
            {...(Platform.OS === "web"
              ? ({ "aria-hidden": true } as object)
              : {})}
          >
            ‹ Sessions
          </Text>
        </Pressable>
        {/* Surface the session title + running-state to AT. A bare
            <div> with aria-label is silently ignored by screen readers
            (ARIA: aria-label on role=generic has no effect). role=group
            gives the wrapper a meaningful role so the composed label
            ("Session foo, running") is actually spoken when focus
            enters the header. */}
        <View
          className="flex-1 items-center flex-row justify-center"
          accessibilityLabel={`Session ${displayName}${isRunning ? ", running" : ""}`}
          {...(Platform.OS === "web" ? { role: "group" as const } : {})}
        >
          <Text
            className="text-tp-text-primary text-[15px] font-semibold"
            numberOfLines={1}
            {...(Platform.OS === "web"
              ? ({ "aria-hidden": true } as object)
              : {})}
          >
            {displayName}
          </Text>
          {isRunning && (
            <View
              className="w-1.5 h-1.5 rounded-full bg-tp-success ml-1.5"
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            />
          )}
        </View>
        {/* Spacer to balance the back button */}
        <View className="w-20" />
      </View>

      {/* Stopped session banner — wrapper is always mounted so a
          screen reader's polite queue gets the "Session ended"
          announcement when the session transitions from running to
          stopped. If the banner is conditionally mounted alongside its
          content, NVDA / JAWS won't observe the text insertion (the
          mutation observer attaches when the live region enters the
          a11y tree, not when text changes on an already-present node)
          and the read-only transition is silently dropped. Matches the
          ConnectionLiveRegion pattern above. */}
      <SessionStoppedLiveRegion stopped={stopped} />

      {/* Connection-state live region. We keep the wrapper mounted at all
          times on a live session so a screen reader's polite queue gets to
          announce the reconnect transition — if the banner unmounts when
          connected flips true, the live region vanishes with it and AT
          users hear nothing about recovery. The visible chrome only
          appears when there's something to say, so sighted users still see
          a clean header when everything is fine. The transient
          "Reconnected" text clears itself after a few seconds so it
          doesn't linger in the layout. */}
      {!stopped && <ConnectionLiveRegion connected={connected} />}

      {/* Segmented control */}
      <SessionSegmentedControl mode={mode} onModeChange={setMode} />

      {/* Content — wrapped as role=tabpanel so the APG Tabs pattern is
          complete (tab↔panel bidirectional link via id/aria-controls
          /aria-labelledby). RN's accessibilityRole union excludes
          "tabpanel" so we spread the raw ARIA attrs on web only.

          Both panel wrappers stay mounted unconditionally so the
          `aria-controls` reference from the inactive tab always points
          at a node that actually exists in the DOM — APG requires the
          referenced element to be present (hidden is fine, missing is
          not). The inactive wrapper gets `hidden` (HTML attr) which
          collapses layout, removes it from the tab order, and lets AT
          skip it. The heavy child views (SessionChatView's record subscription,
          SessionTerminalView's ghostty-web module) only mount when their tab
          is active so we don't double the steady-state cost. */}
      {sid && (
        <View
          ref={chatPanelRef}
          className={mode === "chat" ? "flex-1" : ""}
          {...(Platform.OS === "web"
            ? {
                role: "tabpanel" as const,
                id: SESSION_TABPANEL_CHAT_ID,
                "aria-labelledby": SESSION_TAB_CHAT_ID,
                // `hidden` itself is set imperatively in the
                // chatPanelRef/terminalPanelRef effect above —
                // RN Web's createDOMProps drops it from the JSX
                // attribute pass-through.
              }
            : {})}
        >
          {mode === "chat" && (
            <SessionChatView sid={sid} session={session} stopped={stopped} />
          )}
        </View>
      )}
      {sid && (
        <View
          ref={terminalPanelRef}
          className={mode === "terminal" ? "flex-1" : ""}
          {...(Platform.OS === "web"
            ? {
                role: "tabpanel" as const,
                id: SESSION_TABPANEL_TERMINAL_ID,
                "aria-labelledby": SESSION_TAB_TERMINAL_ID,
              }
            : {})}
        >
          {mode === "terminal" && (
            <SessionTerminalView sid={sid} stopped={stopped} />
          )}
        </View>
      )}

      {/* Safe area bottom */}
      <View
        className="bg-tp-bg-secondary"
        style={{ paddingBottom: insets.bottom }}
      />
    </KeyboardAvoidingView>
  );
}
