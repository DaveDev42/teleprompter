import { Platform, Pressable, Text, View } from "react-native";
import type { ChatMessage } from "../stores/chat-store";
import { useSettingsStore } from "../stores/settings-store";

async function copyText(text: string) {
  if (Platform.OS === "web" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
  // Native: would use expo-clipboard
}

/** Render text with code blocks (```...```) styled differently */
function RichText({
  text,
  className: textClass,
  fontStyle,
  codeFontStyle,
}: {
  text: string;
  className?: string;
  fontStyle?: { fontFamily: string; fontSize: number };
  codeFontStyle?: { fontFamily: string };
}) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  if (parts.length === 1) {
    return (
      <Text className={textClass} style={fontStyle} selectable>
        {text}
      </Text>
    );
  }
  return (
    <View>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim();
          const code = (lang ? lines.slice(1) : lines).join("\n").trim();
          return (
            <Pressable
              key={i}
              className="bg-tp-bg border border-tp-border rounded-lg px-3 py-2 my-1"
              onLongPress={() => copyText(code)}
            >
              {lang ? (
                <Text className="text-tp-text-tertiary text-[10px] mb-1">
                  {lang}
                </Text>
              ) : null}
              <Text className="text-tp-success text-xs" style={codeFontStyle} selectable>
                {code}
              </Text>
            </Pressable>
          );
        }
        return part ? (
          <Text key={i} className={textClass} style={fontStyle} selectable>
            {part}
          </Text>
        ) : null;
      })}
    </View>
  );
}

function UserCard({
  msg,
  fontStyle,
}: {
  msg: ChatMessage;
  fontStyle: { fontFamily: string; fontSize: number };
}) {
  return (
    <Pressable
      className="self-end bg-tp-user-bubble rounded-bubble rounded-br-sm px-4 py-2.5 max-w-[80%]"
      onLongPress={() => copyText(msg.text)}
    >
      <Text
        className="text-white leading-[22px]"
        style={fontStyle}
        selectable
      >
        {msg.text}
      </Text>
    </Pressable>
  );
}

function AssistantCard({
  msg,
  fontStyle,
  codeFontStyle,
}: {
  msg: ChatMessage;
  fontStyle: { fontFamily: string; fontSize: number };
  codeFontStyle: { fontFamily: string };
}) {
  return (
    <Pressable
      className="self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%]"
      onLongPress={() => copyText(msg.text)}
    >
      <RichText
        text={msg.text}
        className="text-tp-text-primary leading-[22px]"
        fontStyle={fontStyle}
        codeFontStyle={codeFontStyle}
      />
    </Pressable>
  );
}

function ToolCard({ msg }: { msg: ChatMessage }) {
  const isResult = msg.event === "PostToolUse";
  return (
    <View className="self-stretch bg-tp-surface border border-tp-border rounded-card px-3.5 py-2.5">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <Text className="text-tp-text-tertiary text-xs mr-1.5">
            {isResult ? "▾" : "▸"}
          </Text>
          <Text
            className="text-tp-text-primary text-[13px] font-medium"
            numberOfLines={1}
          >
            {msg.toolName}
          </Text>
        </View>
        <Text
          className={`text-[11px] ${isResult ? "text-tp-success" : "text-tp-warning"}`}
        >
          {isResult ? "Done" : "Running"}
        </Text>
      </View>
      {msg.toolInput != null && !isResult && (
        <Text
          className="text-tp-text-tertiary text-xs mt-1.5"
          numberOfLines={3}
          selectable
        >
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      )}
      {msg.toolResult != null && isResult && (
        <Text
          className="text-tp-text-secondary text-xs mt-1.5"
          numberOfLines={5}
          selectable
        >
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
      <Text className="text-tp-text-tertiary text-xs">{msg.text}</Text>
    </View>
  );
}

function StreamingCard({
  msg,
  fontStyle,
}: {
  msg: ChatMessage;
  fontStyle: { fontFamily: string; fontSize: number };
}) {
  return (
    <View className="self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%] opacity-70">
      <Text
        className="text-tp-text-secondary italic"
        style={fontStyle}
        selectable
      >
        {msg.text}
      </Text>
    </View>
  );
}

function ElicitationCard({ msg }: { msg: ChatMessage }) {
  return (
    <View className="self-start bg-indigo-900/50 border border-indigo-600 rounded-card px-4 py-3 max-w-[85%]">
      <Text className="text-indigo-300 text-xs font-bold mb-1">
        Input Requested
      </Text>
      <Text className="text-tp-text-primary text-sm" selectable>
        {msg.text}
      </Text>
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
    <View className="self-start bg-amber-900/50 border border-amber-600 rounded-card px-4 py-3 max-w-[85%]">
      <Text className="text-amber-300 text-xs font-bold mb-1">
        Permission Required
      </Text>
      <Text className="text-tp-text-primary text-sm">{msg.text}</Text>
      {msg.permissionTool && (
        <Text className="text-amber-400 text-xs mt-1">
          {msg.permissionTool}
        </Text>
      )}
      {msg.toolInput != null && (
        <Text className="text-tp-text-tertiary text-xs mt-1" numberOfLines={3}>
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      )}
    </View>
  );
}

export function ChatCard({ msg }: { msg: ChatMessage }) {
  const chatFont = useSettingsStore((s) => s.chatFont);
  const codeFont = useSettingsStore((s) => s.codeFont);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontStyle = { fontFamily: chatFont, fontSize };
  const codeFontStyle = { fontFamily: codeFont };

  switch (msg.type) {
    case "user":
      return <UserCard msg={msg} fontStyle={fontStyle} />;
    case "assistant":
      return (
        <AssistantCard
          msg={msg}
          fontStyle={fontStyle}
          codeFontStyle={codeFontStyle}
        />
      );
    case "tool":
      return <ToolCard msg={msg} />;
    case "elicitation":
      return <ElicitationCard msg={msg} />;
    case "permission":
      return <PermissionCard msg={msg} />;
    case "system":
      return <SystemCard msg={msg} />;
    case "streaming":
      return <StreamingCard msg={msg} fontStyle={fontStyle} />;
  }
}
