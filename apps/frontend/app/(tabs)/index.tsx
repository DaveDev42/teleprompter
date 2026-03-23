import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from "react-native";
import { useSessionStore } from "../../src/stores/session-store";
import {
  useChatStore,
  processHookEvent,
  type ChatMessage,
} from "../../src/stores/chat-store";
import { getDaemonClient } from "../../src/hooks/use-daemon";
import { useRouter } from "expo-router";
import { ChatCard } from "../../src/components/ChatCard";
import { VoiceButton } from "../../src/components/VoiceButton";
import { useVoiceStore } from "../../src/stores/voice-store";
import type { WsRec } from "@teleprompter/protocol/client";

export default function ChatScreen() {
  const connected = useSessionStore((s) => s.connected);
  const sid = useSessionStore((s) => s.sid);
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const showTerminalFallback = useChatStore((s) => s.showTerminalFallback);
  const dismissTerminalFallback = useChatStore((s) => s.dismissTerminalFallback);
  const appendStreaming = useChatStore((s) => s.appendStreaming);
  const router = useRouter();
  const setOnPromptReady = useVoiceStore((s) => s.setOnPromptReady);
  const flatListRef = useRef<FlatList>(null);
  const [input, setInput] = useState("");

  // Wire voice prompt to chat send
  useEffect(() => {
    setOnPromptReady((prompt: string) => {
      const client = getDaemonClient();
      if (sid && client) {
        client.sendChat(sid, prompt);
      }
    });
    return () => setOnPromptReady(null);
  }, [sid, setOnPromptReady]);

  // Wire records to chat store
  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k === "event") {
        try {
          const event = JSON.parse(atob(rec.d));
          processHookEvent(event);
        } catch {
          // ignore malformed events
        }
      } else if (rec.k === "io") {
        try {
          const text = atob(rec.d);
          // Strip ANSI escape sequences for chat display
          const clean = text.replace(
            // eslint-disable-next-line no-control-regex
            /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[A-Za-z]/g,
            "",
          );
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

  // Auto-scroll to bottom
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100,
      );
    }
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !sid) return;
    const client = getDaemonClient();
    if (!client) return;
    client.sendChat(sid, text);
    setInput("");
  }, [input, sid]);

  // Build display list: messages + optional streaming bubble
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
    <KeyboardAvoidingView
      className="flex-1 bg-black"
      style={{ flex: 1, backgroundColor: "#000" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* Header */}
      <View className="flex-row items-center px-3 py-2 bg-zinc-900 border-b border-zinc-800" style={{ backgroundColor: "#18181b", paddingHorizontal: 12, paddingVertical: 8 }}>
        <View
          className={`w-2 h-2 rounded-full mr-2 ${connected ? "bg-green-500" : "bg-red-500"}`}
          style={{ width: 8, height: 8, borderRadius: 4, marginRight: 8, backgroundColor: connected ? "#22c55e" : "#ef4444" }}
        />
        <Text className="text-white font-bold" style={{ color: "#fff", fontWeight: "bold" }}>Teleprompter</Text>
        {sid && <Text className="text-gray-500 text-xs ml-2">{sid}</Text>}
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={displayMessages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View className="px-3 py-1">
            <ChatCard msg={item} />
          </View>
        )}
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 8 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => Keyboard.dismiss()}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center pt-20">
            <Text className="text-gray-500">
              {connected
                ? "Waiting for session..."
                : "Connecting to Daemon..."}
            </Text>
          </View>
        }
      />

      {/* Terminal fallback banner */}
      {showTerminalFallback && (
        <View className="flex-row items-center justify-between px-3 py-2 bg-amber-900/50 border-t border-amber-700">
          <Text className="text-amber-200 text-xs flex-1">
            This interaction may work better in the Terminal tab.
          </Text>
          <Pressable
            onPress={() => {
              dismissTerminalFallback();
              router.push("/terminal");
            }}
            className="bg-amber-700 px-3 py-1 rounded ml-2"
          >
            <Text className="text-white text-xs">Switch</Text>
          </Pressable>
          <Pressable
            onPress={dismissTerminalFallback}
            className="ml-2"
          >
            <Text className="text-amber-400 text-xs">Dismiss</Text>
          </Pressable>
        </View>
      )}

      {/* Input */}
      <View className="flex-row items-end px-3 py-2 bg-zinc-900 border-t border-zinc-800">
        <VoiceButton />
        <TextInput
          className="flex-1 bg-zinc-800 text-white rounded-2xl px-4 py-2 mr-2 max-h-24"
          placeholder="Send a message..."
          placeholderTextColor="#666"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          multiline
          returnKeyType="send"
          editable={connected && !!sid}
        />
        <Pressable
          onPress={handleSend}
          disabled={!input.trim() || !connected || !sid}
          className="bg-blue-600 rounded-full w-10 h-10 items-center justify-center"
          style={{ opacity: input.trim() && connected && sid ? 1 : 0.4 }}
        >
          <Text className="text-white text-lg">↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
