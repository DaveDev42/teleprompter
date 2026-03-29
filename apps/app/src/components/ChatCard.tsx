import { View, Text, Pressable, Platform } from "react-native";
import type { ChatMessage } from "../stores/chat-store";

async function copyText(text: string) {
  if (Platform.OS === "web" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
  // Native: would use expo-clipboard
}

/** Render text with code blocks (```...```) styled differently */
function RichText({ text, className: textClass }: { text: string; className?: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  if (parts.length === 1) {
    return <Text className={textClass} selectable>{text}</Text>;
  }
  return (
    <View>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          // Extract language hint and code
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim();
          const code = (lang ? lines.slice(1) : lines).join("\n").trim();
          return (
            <Pressable
              key={i}
              className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 my-1"
              onLongPress={() => copyText(code)}
            >
              {lang ? (
                <Text className="text-gray-500 text-[10px] font-mono mb-1">{lang}</Text>
              ) : null}
              <Text className="text-green-300 text-xs font-mono" selectable>{code}</Text>
            </Pressable>
          );
        }
        return part ? <Text key={i} className={textClass} selectable>{part}</Text> : null;
      })}
    </View>
  );
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
      <RichText text={msg.text} className="text-gray-100" />
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

function ElicitationCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-start bg-indigo-900/50 border border-indigo-600 rounded-xl px-4 py-3 max-w-[85%]">
      <Text className="text-indigo-300 text-xs font-bold mb-1">Input Requested</Text>
      <Text className="text-white text-sm" selectable>{msg.text}</Text>
      {msg.choices && msg.choices.length > 0 && (
        <View className="mt-2 gap-1">
          {msg.choices.map((choice, i) => (
            <View key={i} className="bg-indigo-800/50 rounded-lg px-3 py-1.5">
              <Text className="text-indigo-200 text-sm">{choice}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function PermissionCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-start bg-amber-900/50 border border-amber-600 rounded-xl px-4 py-3 max-w-[85%]">
      <Text className="text-amber-300 text-xs font-bold mb-1">Permission Required</Text>
      <Text className="text-white text-sm">{msg.text}</Text>
      {msg.permissionTool && (
        <Text className="text-amber-400 text-xs font-mono mt-1">{msg.permissionTool}</Text>
      )}
      {msg.toolInput != null && (
        <Text className="text-gray-500 text-xs font-mono mt-1" numberOfLines={3}>
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      )}
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
    case "elicitation":
      return <ElicitationCard msg={msg} />;
    case "permission":
      return <PermissionCard msg={msg} />;
    case "system":
      return <SystemCard msg={msg} />;
    case "streaming":
      return <StreamingCard msg={msg} />;
  }
}
