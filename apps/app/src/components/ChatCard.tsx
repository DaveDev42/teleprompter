import { Platform, Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
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
              accessibilityRole="text"
              accessibilityLabel={`Code block${lang ? `, ${lang}` : ""}`}
              accessibilityHint="Long press to copy"
            >
              {lang ? (
                <Text className="text-tp-text-tertiary text-[10px] mb-1">
                  {lang}
                </Text>
              ) : null}
              <Text
                className="text-tp-success text-xs"
                style={codeFontStyle}
                selectable
              >
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
  const pp = getPlatformProps();
  return (
    <Pressable
      className={`self-end bg-tp-user-bubble rounded-bubble rounded-br-sm px-4 py-2.5 max-w-[80%] ${pp.className}`}
      tabIndex={pp.tabIndex}
      onLongPress={() => copyText(msg.text)}
      accessibilityRole="text"
      accessibilityLabel={`You: ${msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text}`}
      accessibilityHint="Long press to copy"
    >
      <Text className="text-white leading-[22px]" style={fontStyle} selectable>
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
  const pp = getPlatformProps();
  return (
    <Pressable
      className={`self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%] ${pp.className}`}
      tabIndex={pp.tabIndex}
      onLongPress={() => copyText(msg.text)}
      accessibilityRole="text"
      accessibilityLabel={`Claude: ${msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text}`}
      accessibilityHint="Long press to copy"
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Best-effort extraction of stdout/stderr from a Bash PostToolUse result. */
function extractBashOutput(
  result: unknown,
): { stdout?: string; stderr?: string; interrupted?: boolean } | null {
  if (typeof result === "string") return { stdout: result };
  const obj = asRecord(result);
  if (!obj) return null;
  const stdout = asString(obj.stdout) ?? undefined;
  const stderr = asString(obj.stderr) ?? undefined;
  const interrupted = obj.interrupted === true || undefined;
  if (stdout || stderr || interrupted) return { stdout, stderr, interrupted };
  return null;
}

function EditDiff({
  oldStr,
  newStr,
  codeFontStyle,
}: {
  oldStr: string;
  newStr: string;
  codeFontStyle: { fontFamily: string };
}) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  return (
    <View className="mt-1.5 bg-tp-bg border border-tp-border-subtle rounded-lg overflow-hidden">
      {oldLines.map((line, i) => (
        <View key={`old-${i}`} className="flex-row px-2 py-0.5">
          <Text className="text-tp-error text-[11px] w-3" style={codeFontStyle}>
            -
          </Text>
          <Text
            className="text-tp-error text-[11px] flex-1"
            style={codeFontStyle}
            selectable
          >
            {line || " "}
          </Text>
        </View>
      ))}
      {newLines.map((line, i) => (
        <View key={`new-${i}`} className="flex-row px-2 py-0.5">
          <Text
            className="text-tp-success text-[11px] w-3"
            style={codeFontStyle}
          >
            +
          </Text>
          <Text
            className="text-tp-success text-[11px] flex-1"
            style={codeFontStyle}
            selectable
          >
            {line || " "}
          </Text>
        </View>
      ))}
    </View>
  );
}

function BashOutput({
  stdout,
  stderr,
  interrupted,
  codeFontStyle,
}: {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  codeFontStyle: { fontFamily: string };
}) {
  return (
    <View className="mt-1.5 bg-tp-bg border border-tp-border-subtle rounded-lg px-2.5 py-1.5">
      {stdout ? (
        <Text
          className="text-tp-text-secondary text-[11px]"
          style={codeFontStyle}
          numberOfLines={20}
          selectable
        >
          {stdout.trimEnd()}
        </Text>
      ) : null}
      {stderr ? (
        <Text
          className="text-tp-error text-[11px] mt-1"
          style={codeFontStyle}
          numberOfLines={10}
          selectable
        >
          {stderr.trimEnd()}
        </Text>
      ) : null}
      {interrupted ? (
        <Text className="text-tp-warning text-[10px] mt-1 italic">
          (interrupted)
        </Text>
      ) : null}
    </View>
  );
}

function ToolCard({
  msg,
  codeFontStyle,
}: {
  msg: ChatMessage;
  codeFontStyle: { fontFamily: string };
}) {
  const isResult = msg.event === "PostToolUse";
  const toolName = msg.toolName ?? "";
  const inputObj = asRecord(msg.toolInput);

  // Edit / MultiEdit: render a unified diff instead of raw JSON.
  const editOld = inputObj && asString(inputObj.old_string);
  const editNew = inputObj && asString(inputObj.new_string);
  const isEdit =
    (toolName === "Edit" || toolName === "MultiEdit") &&
    editOld !== null &&
    editNew !== null;

  // Write: render the new file content as additions.
  const writeContent = inputObj && asString(inputObj.content);
  const isWrite = toolName === "Write" && writeContent !== null;

  // Bash: extract stdout/stderr for inline rendering.
  const bashOutput =
    toolName === "Bash" && isResult ? extractBashOutput(msg.toolResult) : null;

  // Bash command on the pre-call card.
  const bashCommand =
    toolName === "Bash" && inputObj ? asString(inputObj.command) : null;

  return (
    <View
      className="self-stretch bg-tp-surface border border-tp-border rounded-card px-3.5 py-2.5"
      accessibilityLabel={`Tool ${toolName}, ${isResult ? "completed" : "running"}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <Text className="text-tp-text-tertiary text-xs mr-1.5">
            {isResult ? "▾" : "▸"}
          </Text>
          <Text
            className="text-tp-text-primary text-[13px] font-medium"
            numberOfLines={1}
          >
            {toolName}
          </Text>
        </View>
        <Text
          className={`text-[11px] ${isResult ? "text-tp-success" : "text-tp-warning"}`}
        >
          {isResult ? "Done" : "Running"}
        </Text>
      </View>

      {!isResult && msg.toolInput != null && bashCommand ? (
        <Text
          className="text-tp-text-secondary text-xs mt-1.5"
          style={codeFontStyle}
          numberOfLines={4}
          selectable
        >
          $ {bashCommand}
        </Text>
      ) : !isResult && msg.toolInput != null && isEdit ? (
        <EditDiff
          oldStr={editOld as string}
          newStr={editNew as string}
          codeFontStyle={codeFontStyle}
        />
      ) : !isResult && msg.toolInput != null && isWrite ? (
        <EditDiff
          oldStr=""
          newStr={writeContent as string}
          codeFontStyle={codeFontStyle}
        />
      ) : !isResult && msg.toolInput != null ? (
        <Text
          className="text-tp-text-tertiary text-xs mt-1.5"
          numberOfLines={3}
          selectable
        >
          {typeof msg.toolInput === "string"
            ? msg.toolInput
            : JSON.stringify(msg.toolInput, null, 2)}
        </Text>
      ) : null}

      {/* Post-call body */}
      {isResult && bashOutput ? (
        <BashOutput {...bashOutput} codeFontStyle={codeFontStyle} />
      ) : isResult && msg.toolResult != null ? (
        <Text
          className="text-tp-text-secondary text-xs mt-1.5"
          numberOfLines={5}
          selectable
        >
          {typeof msg.toolResult === "string"
            ? msg.toolResult
            : JSON.stringify(msg.toolResult, null, 2)}
        </Text>
      ) : null}
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
    <View
      className="self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%] opacity-70"
      accessibilityLabel="Claude is typing"
      accessibilityRole="text"
    >
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
    <View
      className="self-start bg-indigo-900/50 border border-indigo-600 rounded-card px-4 py-3 max-w-[85%]"
      accessibilityLabel={`Input requested: ${msg.text}`}
    >
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
    <View
      className="self-start bg-amber-900/50 border border-amber-600 rounded-card px-4 py-3 max-w-[85%]"
      accessibilityLabel={`Permission required: ${msg.text}${msg.permissionTool ? `, tool: ${msg.permissionTool}` : ""}`}
    >
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
      return <ToolCard msg={msg} codeFontStyle={codeFontStyle} />;
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
