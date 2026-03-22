import { View, Text } from "react-native";
import type { ChatMessage } from "../stores/chat-store";

function UserCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-end bg-blue-600 rounded-2xl rounded-br-sm px-4 py-2 max-w-[80%]">
      <Text className="text-white">{msg.text}</Text>
    </View>
  );
}

function AssistantCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-start bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-[80%]">
      <Text className="text-gray-100">{msg.text}</Text>
    </View>
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
      {msg.toolInput && !isResult && (
        <Text className="text-gray-500 text-xs font-mono mt-1" numberOfLines={3}>
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      )}
      {msg.toolResult && isResult && (
        <Text className="text-gray-400 text-xs font-mono mt-1" numberOfLines={5}>
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
      <Text className="text-gray-300 italic">{msg.text}</Text>
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
