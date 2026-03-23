import { View, Text, Pressable, Platform } from "react-native";
import type { ChatMessage } from "../stores/chat-store";

async function copyText(text: string) {
  if (Platform.OS === "web" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
  // Native: would use expo-clipboard
}

function UserCard({ msg }: { msg: ChatMessage }) {
  return (
    <Pressable
      className="self-end bg-blue-600 rounded-2xl rounded-br-sm px-4 py-2 max-w-[80%]"
      onLongPress={() => copyText(msg.text)}
    >
      <Text className="text-white" selectable>{msg.text}</Text>
    </Pressable>
  );
}

function AssistantCard({ msg }: { msg: ChatMessage }) {
  return (
    <Pressable
      className="self-start bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-[80%]"
      onLongPress={() => copyText(msg.text)}
    >
      <Text className="text-gray-100" selectable>{msg.text}</Text>
    </Pressable>
  );
}

function ToolCard({ msg }: { msg: ChatMessage }) {
  const isResult = msg.event === "PostToolUse";
  return (
    <View className="self-start bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 max-w-[90%]">
      <View className="flex-row items-center gap-2">
        <Text className="text-yellow-400 text-xs font-mono">
          {isResult ? "✓" : "▶"} {msg.toolName}
        </Text>
      </View>
      {msg.toolInput != null && !isResult && (
        <Text className="text-gray-500 text-xs font-mono mt-1" numberOfLines={3} selectable>
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      )}
      {msg.toolResult != null && isResult && (
        <Text className="text-gray-400 text-xs font-mono mt-1" numberOfLines={5} selectable>
          {typeof msg.toolResult === "string"
            ? msg.toolResult
            : JSON.stringify(msg.toolResult, null, 2)}
        </Text>
      )}
    </View>
  );
}

function SystemCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-center py-1">
      <Text className="text-gray-500 text-xs">{msg.text}</Text>
    </View>
  );
}

function StreamingCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-start bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-[80%] opacity-70">
      <Text className="text-gray-300 italic" selectable>{msg.text}</Text>
    </View>
  );
}

export function ChatCard({ msg }: { msg: ChatMessage }) {
  switch (msg.type) {
    case "user":
      return <UserCard msg={msg} />;
    case "assistant":
      return <AssistantCard msg={msg} />;
    case "tool":
      return <ToolCard msg={msg} />;
    case "system":
      return <SystemCard msg={msg} />;
    case "streaming":
      return <StreamingCard msg={msg} />;
  }
}
