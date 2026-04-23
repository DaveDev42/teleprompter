import type { WsRec } from "@teleprompter/protocol/client";
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
import type { TerminalSearch } from "../../src/lib/terminal-search";
import {
  addOptimisticUserMessage,
  type ChatMessage,
  processHookEvent,
  useChatStore,
} from "../../src/stores/chat-store";
import { useSessionStore } from "../../src/stores/session-store";
import { setGlobalTermRef, useVoiceStore } from "../../src/stores/voice-store";

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

function ChatView({ sid }: { sid: string }) {
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

  // Wire voice prompt to chat send
  useEffect(() => {
    setOnPromptReady((prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const client = getTransport();
      if (sid && client) {
        // Same trim as daemon-side normalization; keeps dedup tight.
        addOptimisticUserMessage(trimmed);
        client.sendChat(sid, trimmed);
      }
    });
    return () => setOnPromptReady(null);
  }, [sid, setOnPromptReady]);

  // Request record replay on mount
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      const timer = setTimeout(() => client.resume(sid, 0), 500);
      return () => clearTimeout(timer);
    }
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

  // Auto-scroll
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100,
      );
    }
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !sid) return;
    const client = getTransport();
    if (!client) return;
    addOptimisticUserMessage(trimmed);
    client.sendChat(sid, trimmed);
    setInput("");
  }, [input, sid]);

  const displayMessages: ChatMessage[] = [...messages];
  if (streamingText.trim()) {
    displayMessages.push({
      id: "streaming-live",
      type: "streaming",
      text: streamingText.slice(-500),
      ts: Date.now(),
    });
  }

  return (
    <>
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

      {/* Input bar */}
      <View className="flex-row items-end px-3 py-2 bg-tp-bg-secondary border-t border-tp-border">
        <VoiceButton />
        <TextInput
          testID="chat-input"
          className={`flex-1 bg-tp-bg-input text-tp-text-primary rounded-full px-4 py-2 mr-2 max-h-24 text-[15px] ${pp.className}`}
          placeholder="Send a message..."
          placeholderTextColor="var(--tp-text-tertiary)"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          multiline
          returnKeyType="send"
          editable={connected && !!sid}
          accessibilityLabel="Message input"
          accessibilityHint="Type a message to send to Claude"
          tabIndex={pp.tabIndex}
        />
        <Pressable
          testID="chat-send"
          onPress={handleSend}
          disabled={!input.trim() || !connected || !sid}
          className={`bg-tp-accent rounded-full w-9 h-9 items-center justify-center ${pp.className}`}
          tabIndex={pp.tabIndex}
          style={{ opacity: input.trim() && connected && sid ? 1 : 0.4 }}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !input.trim() || !connected || !sid }}
        >
          <Text className="text-white text-lg font-bold">↑</Text>
        </Pressable>
      </View>
    </>
  );
}

function TerminalView({ sid }: { sid: string }) {
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const termRef = useRef<any>(null);
  const searchRef = useRef<TerminalSearch | null>(null);

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

  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k !== "io") return;
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
  }, [addRecHandler, removeRecHandler]);

  const handleData = useCallback(
    (data: string) => {
      const client = getTransport();
      if (!sid || !client) return;
      client.sendTermInput(sid, btoa(data));
    },
    [sid],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const client = getTransport();
      if (sid && client) {
        client.send({ t: "resize", sid, cols, rows });
      }
    },
    [sid],
  );

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

  const session = sessions.find((s) => s.sid === sid);
  const isRunning = session?.state === "running";

  // Attach to session on mount
  useEffect(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      client.attach(sid);
      setSid(sid);
    }
    // Clear chat for fresh state
    useChatStore.getState().clear();

    return () => {
      const c = getTransport();
      if (c && sid) c.detach(sid);
    };
  }, [sid, setSid]);

  // Derive display name from cwd
  const displayName = session?.cwd.split("/").pop() ?? sid ?? "Session";

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

      {/* Segmented control */}
      <SegmentedControl mode={mode} onModeChange={setMode} />

      {/* Content */}
      {sid && mode === "chat" && <ChatView sid={sid} />}
      {sid && mode === "terminal" && <TerminalView sid={sid} />}

      {/* Safe area bottom */}
      <View
        className="bg-tp-bg-secondary"
        style={{ paddingBottom: insets.bottom }}
      />
    </KeyboardAvoidingView>
  );
}
