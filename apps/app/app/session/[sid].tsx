import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatCard } from "../../src/components/ChatCard";
import { VoiceButton } from "../../src/components/VoiceButton";
import { useAnyRelayConnected } from "../../src/hooks/use-relay";
import { getTransport } from "../../src/hooks/use-transport";
import { stripAnsi } from "../../src/lib/ansi-strip";
import { getPlatformProps } from "../../src/lib/get-platform-props";
import {
  deriveInputGates,
  isSessionRunning,
  isSessionStopped,
} from "../../src/lib/session-ux";
import type { TerminalSearch } from "../../src/lib/terminal-search";
import { TERMINAL_COLORS } from "../../src/lib/tokens";
import {
  addOptimisticUserMessage,
  type ChatMessage,
  processHookEvent,
  useChatStore,
} from "../../src/stores/chat-store";
import { useNotificationStore } from "../../src/stores/notification-store";
import { useSessionStore } from "../../src/stores/session-store";
import { useThemeStore } from "../../src/stores/theme-store";
import { setGlobalTermRef, useVoiceStore } from "../../src/stores/voice-store";

// Concrete placeholder colors per theme. `var(--tp-text-tertiary)` resolves
// natively on web but React Native's TextInput needs a plain color literal —
// passing a CSS variable string falls back to the platform default on iOS/Android.
const PLACEHOLDER_LIGHT = "#a1a1aa";
const PLACEHOLDER_DARK = "#71717a";

// Platform-specific terminal component
let TerminalComponent: any = null;
if (Platform.OS === "web") {
  TerminalComponent =
    require("../../src/components/GhosttyTerminal").GhosttyTerminal;
} else {
  TerminalComponent =
    require("../../src/components/GhosttyNative").GhosttyNative;
}

type ViewMode = "chat" | "terminal";

function SegmentedControl({
  mode,
  onModeChange,
}: {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}) {
  const pp = getPlatformProps();
  // APG Tabs keyboard model (automatic activation): ArrowLeft/Right cycle
  // focus across the two tabs *and* activate the focused tab; Home/End jump
  // to the first/last. Without this a keyboard-only user is stuck — the
  // sighted-user workaround is clicking, but a SR user with focus on Chat
  // has no announced way to reach Terminal short of tab-cycling past the
  // tablist entirely. RN's Pressable doesn't surface key events on web, so
  // we attach the handler to the role=tablist container instead.
  const tabOrder: ViewMode[] = ["chat", "terminal"];
  const handleTablistKeyDown = (e: {
    key: string;
    preventDefault: () => void;
  }) => {
    let next: ViewMode | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      const idx = tabOrder.indexOf(mode);
      next = tabOrder[(idx + 1) % tabOrder.length];
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      const idx = tabOrder.indexOf(mode);
      next = tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length];
    } else if (e.key === "Home") {
      next = tabOrder[0];
    } else if (e.key === "End") {
      next = tabOrder[tabOrder.length - 1];
    }
    if (next && next !== mode) {
      e.preventDefault();
      onModeChange(next);
      // Move DOM focus to the newly-activated tab so AT announces the new
      // selection (otherwise focus stays on the previously-focused tab
      // node, which is now visually inactive — confusing to SR users).
      if (Platform.OS === "web") {
        const id =
          next === "chat" ? SESSION_TAB_CHAT_ID : SESSION_TAB_TERMINAL_ID;
        // Defer to the next frame so the re-render that updates aria-selected
        // has settled before we move focus to the freshly-selected tab.
        requestAnimationFrame(() => {
          document.getElementById(id)?.focus();
        });
      }
    }
  };
  // RN Web's Pressable doesn't translate `accessibilityState.selected` into
  // `aria-selected`, so screen readers can't tell which tab is active. Pass
  // the raw ARIA attribute via a web-only spread; native ignores it. Same
  // pattern for `id` + `aria-controls` — without those the APG Tabs pattern
  // is incomplete (no tab↔panel relationship in the a11y tree), so screen
  // readers don't know which content region belongs to which tab.
  const webTabChat =
    Platform.OS === "web"
      ? {
          "aria-selected": mode === "chat",
          id: SESSION_TAB_CHAT_ID,
          "aria-controls": SESSION_TABPANEL_CHAT_ID,
        }
      : {};
  const webTabTerminal =
    Platform.OS === "web"
      ? {
          "aria-selected": mode === "terminal",
          id: SESSION_TAB_TERMINAL_ID,
          "aria-controls": SESSION_TABPANEL_TERMINAL_ID,
        }
      : {};
  // RN propagates accessibilityRole verbatim to web — but "tabbar" is not a
  // valid ARIA role (the standard is "tablist"). Without a web override SR
  // and DOM tooling see role="tabbar" and skip the tab semantics. Override
  // via the `role` prop on web; native keeps tabbar which RN recognizes.
  const tablistWebProps =
    Platform.OS === "web"
      ? {
          role: "tablist" as const,
          onKeyDown: handleTablistKeyDown,
        }
      : {};
  return (
    <View className="px-4 py-2 bg-tp-bg-secondary">
      <View
        className="flex-row bg-tp-bg-tertiary rounded-btn p-1"
        accessibilityRole="tabbar"
        {...tablistWebProps}
      >
        <Pressable
          testID="tab-chat"
          onPress={() => onModeChange("chat")}
          accessibilityRole="tab"
          accessibilityLabel="Chat"
          accessibilityState={{ selected: mode === "chat" }}
          {...(webTabChat as object)}
          tabIndex={pp.tabIndex}
          className={`flex-1 py-1.5 rounded-badge items-center ${
            mode === "chat" ? "bg-tp-surface" : ""
          } ${pp.className}`}
        >
          <Text
            className={`text-[13px] ${
              mode === "chat"
                ? "text-tp-text-primary font-semibold"
                : "text-tp-text-secondary font-medium"
            }`}
          >
            Chat
          </Text>
        </Pressable>
        <Pressable
          testID="tab-terminal"
          onPress={() => onModeChange("terminal")}
          accessibilityRole="tab"
          accessibilityLabel="Terminal"
          accessibilityState={{ selected: mode === "terminal" }}
          {...(webTabTerminal as object)}
          tabIndex={pp.tabIndex}
          className={`flex-1 py-1.5 rounded-badge items-center ${
            mode === "terminal" ? "bg-tp-surface" : ""
          } ${pp.className}`}
        >
          <Text
            className={`text-[13px] ${
              mode === "terminal"
                ? "text-tp-text-primary font-semibold"
                : "text-tp-text-secondary font-medium"
            }`}
          >
            Terminal
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// APG Tabs pattern: tab ↔ tabpanel are bidirectionally linked by id /
// aria-controls / aria-labelledby. Centralise the ids so SegmentedControl
// and the tabpanel wrappers below stay in lock-step.
const SESSION_TAB_CHAT_ID = "session-tab-chat";
const SESSION_TAB_TERMINAL_ID = "session-tab-terminal";
const SESSION_TABPANEL_CHAT_ID = "session-tabpanel-chat";
const SESSION_TABPANEL_TERMINAL_ID = "session-tabpanel-terminal";

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
function ConnectionLiveRegion({ connected }: { connected: boolean }) {
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

  // Render the wrapper unconditionally so AT keeps a stable live region
  // attached. The visible chrome is the only thing that toggles.
  return (
    <View
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

function ChatView({
  sid,
  session,
  stopped,
}: {
  sid: string;
  session: WsSessionMeta | undefined;
  stopped: boolean;
}) {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const appendStreaming = useChatStore((s) => s.appendStreaming);
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const connected = useAnyRelayConnected();
  const flatListRef = useRef<FlatList>(null);
  const sendRef = useRef<View>(null);
  const chatInputRef = useRef<TextInput>(null);
  const [input, setInput] = useState("");
  const setOnPromptReady = useVoiceStore((s) => s.setOnPromptReady);
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = isDark ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT;
  const { isEditable, canSend } = deriveInputGates(session, connected, sid);

  // Wire voice prompt to chat send
  useEffect(() => {
    setOnPromptReady((prompt: string) => {
      if (stopped) return;
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const client = getTransport();
      if (sid && client) {
        // Trim for display + empty-prompt guard; dedup comparison trims separately.
        addOptimisticUserMessage(trimmed);
        client.sendChat(sid, trimmed);
      }
    });
    return () => setOnPromptReady(null);
  }, [sid, stopped, setOnPromptReady]);

  // Reset composer draft on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the per-session reset
  useEffect(() => {
    setInput("");
  }, [sid]);

  // Move focus to the Back button on first mount / session change. Without
  // this, focus stays on <body> after navigation (especially deep links and
  // browser refreshes on /session/:sid) — keyboard and screen-reader users
  // get dropped onto the page with no announced focus point and have to
  // press Tab blindly to find an anchor. Defer until next frame so RN Web
  // has actually mounted the Pressable's underlying DOM node. Skip if the
  // user has already focused something themselves (e.g. clicked into the
  // chat input before this fires).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the focus reset
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const raf = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        return;
      }
      const back = document.querySelector<HTMLElement>(
        '[data-testid="session-back"]',
      );
      back?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [sid]);

  // RN Web's `multiline` TextInput renders as <textarea rows="2"> with a
  // fixed height — Shift+Enter newlines stack invisibly inside the same
  // 52px box. Resize the textarea to fit content on every change (clamped
  // by the existing `max-h-24` Tailwind class via CSS max-height, then
  // internal scroll takes over). Reset to "auto" first so shrinking works
  // when the user deletes lines. `input` is not read directly inside the
  // effect body, but its change is the trigger — el.scrollHeight reflects the
  // updated DOM after RN Web re-renders with the new value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — input drives re-run via DOM side-effect
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = chatInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Request record replay on mount. The relay client queues the frame if
  // key exchange hasn't finished yet and flushes on auth.ok, so we no longer
  // need the 500ms timer hack that previously raced the kx handshake.
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) client.resume(sid, 0);
  }, [sid]);

  // Mirror disabled state to aria-disabled on the Send button. RN Web's
  // Pressable only emits aria-disabled when the native `disabled` prop is
  // also set, which would remove the button from Tab order. We keep it
  // focusable and announce the disabled state via this side-channel.
  const sendDisabled = !input.trim() || !canSend;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = sendRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (sendDisabled) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }, [sendDisabled]);

  // Wire records to chat store
  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k === "event") {
        try {
          const eventBytes = Uint8Array.from(atob(rec.d), (c) =>
            c.charCodeAt(0),
          );
          const event = JSON.parse(new TextDecoder("utf-8").decode(eventBytes));
          processHookEvent(event);
        } catch {
          // ignore
        }
      } else if (rec.k === "io") {
        // Only buffer PTY text while Claude is actively producing a response
        // (UserPromptSubmit ... Stop). Otherwise the user's INSERT-mode
        // keystroke echoes, autocomplete dropdown repaints, and other UI
        // chatter would accumulate in streamingText and pollute the next
        // committed bubble. Reads the latest store state so the gate
        // reflects events processed earlier in this same record batch.
        if (!useChatStore.getState().isAssistantResponding) return;
        try {
          const bytes = Uint8Array.from(atob(rec.d), (c) => c.charCodeAt(0));
          const text = new TextDecoder("utf-8").decode(bytes);
          const clean = stripAnsi(text);
          if (clean.trim()) {
            appendStreaming(clean);
          }
        } catch {
          // ignore
        }
      }
    };
    addRecHandler(handler);
    return () => removeRecHandler(handler);
  }, [addRecHandler, removeRecHandler, appendStreaming]);

  // Auto-scroll on new messages AND on streaming growth so the live
  // assistant bubble stays in view while Claude is mid-response. The 100ms
  // debounce coalesces the PTY-chunk firehose so we don't queue a scroll
  // per frame.
  useEffect(() => {
    if (messages.length === 0 && !streamingText) return;
    const t = setTimeout(
      () => flatListRef.current?.scrollToEnd({ animated: true }),
      100,
    );
    return () => clearTimeout(t);
  }, [messages.length, streamingText]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !sid || stopped) return;
    const client = getTransport();
    if (!client) {
      // No paired daemon — clearing the input + a toast tells the user
      // their keystrokes weren't lost into a void. Previously this was a
      // silent return, so users couldn't tell why nothing happened.
      useNotificationStore.getState().showToast({
        title: "Not paired",
        body: "Pair a daemon to send messages.",
      });
      setInput("");
      return;
    }
    // Optimistic add must precede sendChat so the echoed hook event dedups.
    addOptimisticUserMessage(trimmed);
    client.sendChat(sid, trimmed);
    setInput("");
  }, [input, sid, stopped]);

  const displayMessages: ChatMessage[] = [...messages];
  if (streamingText.trim()) {
    displayMessages.push({
      id: "streaming-live",
      type: "streaming",
      text: streamingText,
      ts: Date.now(),
    });
  }

  // On web, expose the chat messages container as a `log` landmark.
  // role=log implies `aria-live=polite` + `aria-relevant=additions text`
  // (ARIA spec), so AT announces appended messages without interrupting
  // the user. Setting `aria-live` / `aria-relevant` directly doesn't
  // work: RN Web's createDOMProps drops `aria-relevant` entirely, and
  // `aria-live=polite` without a landmark role doesn't tell AT that
  // this is a chat transcript (vs a generic status region). FlatList
  // doesn't forward arbitrary ARIA props cleanly, so the role rides on
  // the wrapping View.
  const liveRegionProps = Platform.OS === "web" ? { role: "log" as const } : {};

  return (
    <>
      <View className="flex-1" {...(liveRegionProps as object)}>
        <FlatList
          ref={flatListRef}
          data={displayMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            // role=listitem so the parent role=list has valid ARIA
            // children on web — FlatList's internal cell wrapper is a
            // plain div there. RN's AccessibilityRole union doesn't
            // include "listitem", so spread `role` directly on web.
            <View
              className="px-4 py-1"
              {...(Platform.OS === "web" ? { role: "listitem" } : {})}
            >
              <ChatCard msg={item} />
            </View>
          )}
          className="flex-1"
          contentContainerStyle={{ paddingVertical: 8 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => Keyboard.dismiss()}
          accessibilityRole="list"
          accessibilityLabel="Chat messages"
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center pt-20">
              <Text className="text-tp-text-tertiary text-[15px]">
                {!connected
                  ? "Connecting to daemon..."
                  : "Listening to Claude Code..."}
              </Text>
            </View>
          }
        />
      </View>

      {/* Input bar */}
      <View className="flex-row items-end px-3 py-2 bg-tp-bg-secondary border-t border-tp-border">
        <VoiceButton disabled={stopped} />
        <TextInput
          ref={chatInputRef}
          testID="chat-input"
          className={`flex-1 bg-tp-bg-input text-tp-text-primary rounded-full px-4 py-2 mr-2 max-h-24 text-[15px] ${pp.className}`}
          placeholder={stopped ? "Session ended" : "Send a message..."}
          placeholderTextColor={placeholderColor}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          // Web: react-native-web's multiline TextInput inserts a newline on
          // Enter regardless of returnKeyType. Intercept onKeyPress so Enter
          // (without Shift) submits like every other chat UI. Native keeps
          // onSubmitEditing as the trigger.
          // `isComposing` guards CJK IME: pressing Enter to commit a Hangul/
          // Kana/Pinyin candidate fires keydown with key="Enter" AND
          // isComposing=true. Without this check the message sends mid-
          // composition and the candidate text is dropped.
          onKeyPress={
            Platform.OS === "web"
              ? (e) => {
                  const ne = e.nativeEvent as unknown as {
                    key: string;
                    shiftKey?: boolean;
                    isComposing?: boolean;
                  };
                  if (ne.key === "Enter" && !ne.shiftKey && !ne.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }
              : undefined
          }
          multiline
          returnKeyType="send"
          editable={isEditable}
          accessibilityLabel="Message input"
          accessibilityHint={
            stopped
              ? "This session has ended. New prompts cannot be sent."
              : !connected
                ? "Disconnected. Compose a message to send when reconnected."
                : "Type a message to send to Claude (Shift+Enter for newline)"
          }
          tabIndex={pp.tabIndex}
        />
        <Pressable
          testID="chat-send"
          ref={sendRef}
          // `disabled` maps to HTML `disabled` on RN Web, which removes the
          // button from the browser's Tab order entirely. Keyboard-only
          // users typing in the composer would Tab straight past Send to
          // the rest of the page with no way back. Drop the native
          // `disabled` and use an onPress guard so the button stays
          // focusable and no-ops on activation when not ready. We still
          // want screen readers to hear "disabled" while the composer is
          // empty — RN Web's Pressable strips a spread `aria-disabled`
          // unless the native `disabled` prop is also set, so we apply it
          // via a layout effect on the underlying DOM node.
          onPress={() => {
            if (!input.trim() || !canSend) return;
            handleSend();
          }}
          className={`bg-tp-accent rounded-full w-9 h-9 items-center justify-center ${pp.className}`}
          tabIndex={pp.tabIndex}
          style={{ opacity: input.trim() && canSend ? 1 : 0.4 }}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !input.trim() || !canSend }}
        >
          <Text className="text-tp-text-on-color text-lg font-bold">↑</Text>
        </Pressable>
      </View>
    </>
  );
}

function TerminalView({ sid, stopped }: { sid: string; stopped: boolean }) {
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const termRef = useRef<any>(null);
  const searchRef = useRef<TerminalSearch | null>(null);
  // `hasIo` flips true once any io record arrives (live or replayed).
  // `replaySettled` flips true only after 500ms of silence from the
  // daemon — every record of any kind (io, event, meta) rearms the
  // window by resetting replaySettled to false and restarting the timer.
  // The overlay only renders when all three align: stopped, no io seen,
  // and the daemon has been quiet long enough that more records are
  // unlikely to arrive.
  const [hasIo, setHasIo] = useState(false);
  const [replaySettled, setReplaySettled] = useState(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    // Flip replaySettled back to false — a late record arriving after the
    // window elapsed should reopen it, not leave a stale "settled" latch.
    setReplaySettled(false);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setReplaySettled(true);
    }, 500);
  }, []);

  useEffect(() => {
    setGlobalTermRef(termRef.current);
    return () => setGlobalTermRef(null);
  });

  const handleTermReady = useCallback(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      client.resume(sid, 0);
    }
  }, [sid]);

  // Reset per-session overlay state when switching sessions and start the
  // initial silence window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the per-session reset
  useEffect(() => {
    setHasIo(false);
    setReplaySettled(false);
    armSettleTimer();
    return () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [sid, armSettleTimer]);

  useEffect(() => {
    const handler = (rec: WsRec) => {
      // Any record arriving means replay/stream is still flowing — push
      // the empty-state overlay back by restarting the silence window.
      armSettleTimer();
      if (rec.k !== "io") return;
      setHasIo(true);
      const term = termRef.current;
      if (!term) return;
      try {
        const binary = atob(rec.d);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);
      } catch {
        term.write(rec.d);
      }
    };
    addRecHandler(handler);
    return () => removeRecHandler(handler);
  }, [addRecHandler, removeRecHandler, armSettleTimer]);

  const handleData = useCallback(
    (data: string) => {
      if (stopped) return;
      const client = getTransport();
      if (!sid || !client) return;
      client.sendTermInput(sid, btoa(data));
    },
    [sid, stopped],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (stopped) return;
      const client = getTransport();
      if (sid && client) {
        client.send({ t: "resize", sid, cols, rows });
      }
    },
    [sid, stopped],
  );

  const showEmptyFallback = stopped && !hasIo && replaySettled;

  return (
    <View
      className="flex-1"
      style={{ backgroundColor: TERMINAL_COLORS.background }}
    >
      {TerminalComponent && (
        <TerminalComponent
          onData={handleData}
          onResize={handleResize}
          termRef={termRef}
          onReady={handleTermReady}
          searchRef={searchRef}
        />
      )}
      {showEmptyFallback && (
        <View
          testID="terminal-empty-fallback"
          className="absolute inset-0 items-center justify-center px-6"
          pointerEvents="none"
        >
          <Text className="text-tp-text-tertiary text-[13px] text-center">
            No terminal output captured for this session.
          </Text>
        </View>
      )}
    </View>
  );
}

export default function SessionDetailScreen() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sessions = useSessionStore((s) => s.sessions);
  const setSid = useSessionStore((s) => s.setSid);
  const [mode, setMode] = useState<ViewMode>("chat");
  const pp = getPlatformProps();
  const connected = useAnyRelayConnected();

  const session = sessions.find((s) => s.sid === sid);
  const stopped = isSessionStopped(session);
  const isRunning = isSessionRunning(session);

  // Attach to session on mount
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      client.attach(sid);
      setSid(sid);
    }
    // Clear chat and reset to chat tab for fresh state on session switch
    useChatStore.getState().clear();
    setMode("chat");

    return () => {
      const c = getTransport();
      if (c && sid) c.detach(sid);
    };
  }, [sid, setSid]);

  // Derive display name from cwd. Strip a trailing slash first so a path like
  // "/Users/dave/proj/" yields "proj" rather than an empty string.
  const displayName =
    session?.cwd.replace(/\/+$/, "").split("/").pop() ?? sid ?? "Session";

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-tp-bg"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
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
          <Text className="text-tp-accent text-base font-medium">
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
          >
            {displayName}
          </Text>
          {isRunning && (
            <View className="w-1.5 h-1.5 rounded-full bg-tp-success ml-1.5" />
          )}
        </View>
        {/* Spacer to balance the back button */}
        <View className="w-20" />
      </View>

      {/* Stopped session banner */}
      {stopped && (
        <View
          testID="session-stopped-banner"
          role="status"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Session ended. Read-only view."
          className="flex-row items-center px-4 py-2 bg-tp-bg-secondary border-b border-tp-border"
        >
          <View className="w-1.5 h-1.5 rounded-full bg-tp-warning mr-2" />
          <Text className="text-tp-text-secondary text-[12px] font-medium">
            Session ended — read-only view
          </Text>
        </View>
      )}

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
      <SegmentedControl mode={mode} onModeChange={setMode} />

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
          skip it. The heavy child views (ChatView's record subscription,
          TerminalView's ghostty-web module) only mount when their tab
          is active so we don't double the steady-state cost. */}
      {sid && (
        <View
          className={mode === "chat" ? "flex-1" : ""}
          {...(Platform.OS === "web"
            ? {
                role: "tabpanel" as const,
                id: SESSION_TABPANEL_CHAT_ID,
                "aria-labelledby": SESSION_TAB_CHAT_ID,
                hidden: mode !== "chat",
              }
            : {})}
        >
          {mode === "chat" && (
            <ChatView sid={sid} session={session} stopped={stopped} />
          )}
        </View>
      )}
      {sid && (
        <View
          className={mode === "terminal" ? "flex-1" : ""}
          {...(Platform.OS === "web"
            ? {
                role: "tabpanel" as const,
                id: SESSION_TABPANEL_TERMINAL_ID,
                "aria-labelledby": SESSION_TAB_TERMINAL_ID,
                hidden: mode !== "terminal",
              }
            : {})}
        >
          {mode === "terminal" && <TerminalView sid={sid} stopped={stopped} />}
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
