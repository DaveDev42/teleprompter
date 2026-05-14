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
import {
  addOptimisticUserMessage,
  type ChatMessage,
  processHookEvent,
  useChatStore,
} from "../../src/stores/chat-store";
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
  // RN Web's Pressable doesn't translate `accessibilityState.selected` into
  // `aria-selected`, so screen readers can't tell which tab is active. Pass
  // the raw ARIA attribute via a web-only spread; native ignores it.
  const ariaSelectedChat =
    Platform.OS === "web" ? { "aria-selected": mode === "chat" } : {};
  const ariaSelectedTerminal =
    Platform.OS === "web" ? { "aria-selected": mode === "terminal" } : {};
  return (
    <View className="px-4 py-2 bg-tp-bg-secondary">
      <View
        className="flex-row bg-tp-bg-tertiary rounded-btn p-1"
        accessibilityRole="tabbar"
      >
        <Pressable
          testID="tab-chat"
          onPress={() => onModeChange("chat")}
          accessibilityRole="tab"
          accessibilityLabel="Chat"
          accessibilityState={{ selected: mode === "chat" }}
          {...(ariaSelectedChat as object)}
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
          {...(ariaSelectedTerminal as object)}
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

  // Request record replay on mount. The relay client queues the frame if
  // key exchange hasn't finished yet and flushes on auth.ok, so we no longer
  // need the 500ms timer hack that previously raced the kx handshake.
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) client.resume(sid, 0);
  }, [sid]);

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
    if (!client) return;
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

  // On web, announce new chat messages to screen readers via aria-live.
  // `polite` queues announcements without interrupting the user's current
  // reading. FlatList doesn't forward arbitrary ARIA props cleanly, so we
  // wrap it in a host View that carries the attribute.
  const liveRegionProps =
    Platform.OS === "web"
      ? {
          "aria-live": "polite" as const,
          "aria-relevant": "additions" as const,
        }
      : {};

  return (
    <>
      <View className="flex-1" {...(liveRegionProps as object)}>
        <FlatList
          ref={flatListRef}
          data={displayMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View className="px-4 py-1">
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
          onKeyPress={
            Platform.OS === "web"
              ? (e) => {
                  const ne = e.nativeEvent as unknown as {
                    key: string;
                    shiftKey?: boolean;
                  };
                  if (ne.key === "Enter" && !ne.shiftKey) {
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
          onPress={handleSend}
          disabled={!input.trim() || !canSend}
          className={`bg-tp-accent rounded-full w-9 h-9 items-center justify-center ${pp.className}`}
          tabIndex={pp.tabIndex}
          style={{ opacity: input.trim() && canSend ? 1 : 0.4 }}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !input.trim() || !canSend }}
        >
          <Text className="text-white text-lg font-bold">↑</Text>
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
    <View className="flex-1 bg-black">
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
          onPress={() => router.back()}
          className={`px-2 ${pp.className}`}
          tabIndex={pp.tabIndex}
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
        >
          <Text className="text-tp-accent text-base font-medium">
            ‹ Sessions
          </Text>
        </Pressable>
        <View
          className="flex-1 items-center flex-row justify-center"
          accessibilityLabel={`Session ${displayName}${isRunning ? ", running" : ""}`}
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

      {/* Disconnected banner — shown when the relay link is down on a live
          session so the user understands why pressing Send appears to no-op. */}
      {!stopped && !connected && (
        <View
          testID="session-disconnected-banner"
          role="status"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Disconnected. Messages will send after reconnect."
          className="flex-row items-center px-4 py-2 bg-tp-bg-secondary border-b border-tp-border"
        >
          <View className="w-1.5 h-1.5 rounded-full bg-tp-text-tertiary mr-2" />
          <Text className="text-tp-text-secondary text-[12px] font-medium">
            Disconnected — messages will send after reconnect
          </Text>
        </View>
      )}

      {/* Segmented control */}
      <SegmentedControl mode={mode} onModeChange={setMode} />

      {/* Content */}
      {sid && mode === "chat" && (
        <ChatView sid={sid} session={session} stopped={stopped} />
      )}
      {sid && mode === "terminal" && (
        <TerminalView sid={sid} stopped={stopped} />
      )}

      {/* Safe area bottom */}
      <View
        className="bg-tp-bg-secondary"
        style={{ paddingBottom: insets.bottom }}
      />
    </KeyboardAvoidingView>
  );
}
