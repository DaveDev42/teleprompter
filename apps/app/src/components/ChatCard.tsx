import { useState } from "react";
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

// ─── Inline markdown parser ──────────────────────────────────────────────────

type InlineSeg =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string };

/** Split a line into bold/italic/code/plain inline segments. */
function parseInline(raw: string): InlineSeg[] {
  const INLINE_RE = /(\*\*[\s\S]*?\*\*|\*[\s\S]*?\*|`[^`]+`)/g;
  const segs: InlineSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional loop
  while ((m = INLINE_RE.exec(raw)) !== null) {
    if (m.index > last) segs.push({ t: "text", s: raw.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) segs.push({ t: "bold", s: tok.slice(2, -2) });
    else if (tok.startsWith("`")) segs.push({ t: "code", s: tok.slice(1, -1) });
    else segs.push({ t: "italic", s: tok.slice(1, -1) });
    last = m.index + tok.length;
  }
  if (last < raw.length) segs.push({ t: "text", s: raw.slice(last) });
  return segs;
}

function InlineText({
  raw,
  textClass,
  fontStyle,
  codeFontStyle,
}: {
  raw: string;
  textClass?: string;
  fontStyle?: { fontFamily: string; fontSize: number };
  codeFontStyle?: { fontFamily: string };
}) {
  const segs = parseInline(raw);
  if (segs.length === 1 && segs[0].t === "text") {
    return (
      <Text className={textClass} style={fontStyle} selectable>
        {raw}
      </Text>
    );
  }
  return (
    <Text className={textClass} style={fontStyle} selectable>
      {segs.map((seg, i) => {
        switch (seg.t) {
          case "bold":
            return (
              <Text
                key={i}
                className={textClass}
                style={{ ...fontStyle, fontWeight: "700" }}
              >
                {seg.s}
              </Text>
            );
          case "italic":
            return (
              <Text
                key={i}
                className={textClass}
                style={{ ...fontStyle, fontStyle: "italic" }}
              >
                {seg.s}
              </Text>
            );
          case "code":
            return (
              <Text
                key={i}
                className="text-tp-success bg-tp-bg rounded px-0.5 text-xs"
                style={codeFontStyle}
              >
                {seg.s}
              </Text>
            );
          default:
            return <Text key={i}>{seg.s}</Text>;
        }
      })}
    </Text>
  );
}

// ─── Block markdown parser ───────────────────────────────────────────────────

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "para"; text: string };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  // Normalise line endings; ensure trailing newline for the fence detector.
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── fenced code block ──────────────────────────────────────────
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // ── ATX heading ───────────────────────────────────────────────
    const hMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      blocks.push({
        type: "heading",
        level: Math.min(hMatch[1].length, 3) as 1 | 2 | 3,
        text: hMatch[2].trim(),
      });
      i++;
      continue;
    }

    // ── unordered list item ───────────────────────────────────────
    const ulMatch = line.match(/^\s*[-*]\s+(.*)/);
    if (ulMatch) {
      const items: string[] = [ulMatch[1]];
      i++;
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+(.*)/)) {
        items.push((lines[i].match(/^\s*[-*]\s+(.*)/) as RegExpMatchArray)[1]);
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // ── ordered list item ─────────────────────────────────────────
    const olMatch = line.match(/^\s*\d+\.\s+(.*)/);
    if (olMatch) {
      const items: string[] = [olMatch[1]];
      i++;
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+(.*)/)) {
        items.push((lines[i].match(/^\s*\d+\.\s+(.*)/) as RegExpMatchArray)[1]);
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // ── blank line (skip) ─────────────────────────────────────────
    if (line.trim() === "") {
      i++;
      continue;
    }

    // ── paragraph (accumulate until blank/heading/list/fence) ─────
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].match(/^#{1,3}\s/) &&
      !lines[i].match(/^\s*[-*]\s/) &&
      !lines[i].match(/^\s*\d+\.\s/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", text: paraLines.join("\n") });
  }

  return blocks;
}

/** Render text with full markdown support (headings, lists, code, inline). */
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
  // Fast path: if there is no markdown syntax, skip parsing entirely.
  const hasMd = /```|^#{1,3}\s|^\s*[-*]\s|^\s*\d+\.\s|\*\*|\*[^*]|`[^`]/m.test(
    text,
  );
  if (!hasMd) {
    return (
      <Text className={textClass} style={fontStyle} selectable>
        {text}
      </Text>
    );
  }

  const blocks = parseBlocks(text);
  if (blocks.length === 0) {
    return (
      <Text className={textClass} style={fontStyle} selectable>
        {text}
      </Text>
    );
  }

  return (
    <View>
      {blocks.map((block, bi) => {
        switch (block.type) {
          case "heading": {
            const hClass =
              block.level === 1
                ? "text-tp-text-primary text-[18px] font-bold mt-2 mb-0.5"
                : block.level === 2
                  ? "text-tp-text-primary text-[16px] font-bold mt-1.5 mb-0.5"
                  : "text-tp-text-primary text-[14px] font-semibold mt-1";
            return (
              <Text
                key={bi}
                className={hClass}
                style={{ fontFamily: fontStyle?.fontFamily }}
                selectable
              >
                {block.text}
              </Text>
            );
          }
          case "code": {
            return (
              <Pressable
                key={bi}
                className="bg-tp-bg border border-tp-border rounded-lg px-3 py-2 my-1"
                onLongPress={() => copyText(block.code)}
                accessibilityRole="text"
                accessibilityLabel={`Code block${block.lang ? `, ${block.lang}` : ""}`}
                accessibilityHint="Long press to copy"
              >
                {block.lang ? (
                  <Text className="text-tp-text-tertiary text-[10px] mb-1">
                    {block.lang}
                  </Text>
                ) : null}
                <Text
                  className="text-tp-success text-xs"
                  style={codeFontStyle}
                  selectable
                >
                  {block.code}
                </Text>
              </Pressable>
            );
          }
          case "list": {
            return (
              <View key={bi} className="my-0.5">
                {block.items.map((item, ii) => (
                  <View key={ii} className="flex-row items-start mb-0.5">
                    <Text
                      className={`${textClass} mr-1.5 mt-0.5`}
                      style={fontStyle}
                    >
                      {block.ordered ? `${ii + 1}.` : "•"}
                    </Text>
                    <View className="flex-1">
                      <InlineText
                        raw={item}
                        textClass={textClass}
                        fontStyle={fontStyle}
                        codeFontStyle={codeFontStyle}
                      />
                    </View>
                  </View>
                ))}
              </View>
            );
          }
          case "para": {
            return (
              <InlineText
                key={bi}
                raw={block.text}
                textClass={textClass}
                fontStyle={fontStyle}
                codeFontStyle={codeFontStyle}
              />
            );
          }
          default:
            return null;
        }
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
  expanded,
}: {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  codeFontStyle: { fontFamily: string };
  expanded: boolean;
}) {
  return (
    <View className="mt-1.5 bg-tp-bg border border-tp-border-subtle rounded-lg px-2.5 py-1.5">
      {stdout ? (
        <Text
          className="text-tp-text-secondary text-[11px]"
          style={codeFontStyle}
          numberOfLines={expanded ? undefined : 20}
          selectable
        >
          {stdout.trimEnd()}
        </Text>
      ) : null}
      {stderr ? (
        <Text
          className="text-tp-error text-[11px] mt-1"
          style={codeFontStyle}
          numberOfLines={expanded ? undefined : 10}
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
  const [expanded, setExpanded] = useState(false);
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

  // Detect output that exceeds the collapsed numberOfLines so we know whether
  // to show the "Show more" affordance. Cheap line count — splits on \n once.
  const collapsedThreshold = bashOutput ? 20 : 5;
  const truncatedSource = bashOutput
    ? (bashOutput.stdout ?? "") + (bashOutput.stderr ?? "")
    : isResult && msg.toolResult != null
      ? typeof msg.toolResult === "string"
        ? msg.toolResult
        : JSON.stringify(msg.toolResult, null, 2)
      : "";
  const isTruncatable =
    truncatedSource.split("\n").length > collapsedThreshold ||
    truncatedSource.length > collapsedThreshold * 80;

  return (
    <Pressable
      onPress={() => {
        if (isResult && isTruncatable) setExpanded((v) => !v);
      }}
      className="self-stretch bg-tp-surface border border-tp-border rounded-card px-3.5 py-2.5"
      accessibilityLabel={`Tool ${toolName}, ${isResult ? "completed" : "running"}${isTruncatable ? `, ${expanded ? "expanded" : "collapsed"}` : ""}`}
      accessibilityRole={isResult && isTruncatable ? "button" : undefined}
      accessibilityHint={
        isResult && isTruncatable
          ? expanded
            ? "Tap to collapse"
            : "Tap to expand full output"
          : undefined
      }
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <Text className="text-tp-text-tertiary text-xs mr-1.5">
            {isResult ? (expanded ? "▾" : "▸") : "▸"}
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
        <BashOutput
          {...bashOutput}
          codeFontStyle={codeFontStyle}
          expanded={expanded}
        />
      ) : isResult && msg.toolResult != null ? (
        <Text
          className="text-tp-text-secondary text-xs mt-1.5"
          numberOfLines={expanded ? undefined : 5}
          selectable
        >
          {typeof msg.toolResult === "string"
            ? msg.toolResult
            : JSON.stringify(msg.toolResult, null, 2)}
        </Text>
      ) : null}

      {isResult && isTruncatable ? (
        <Text className="text-tp-accent text-[11px] mt-1.5">
          {expanded ? "Show less" : "Show more"}
        </Text>
      ) : null}
    </Pressable>
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
      className="self-start bg-tp-surface border border-tp-accent rounded-card px-4 py-3 max-w-[85%]"
      accessibilityLabel={`Input requested: ${msg.text}`}
    >
      <Text className="text-tp-accent text-xs font-bold mb-1">
        Input Requested
      </Text>
      <Text className="text-tp-text-primary text-sm" selectable>
        {msg.text}
      </Text>
      {msg.choices && msg.choices.length > 0 && (
        <View className="mt-2 gap-1">
          {msg.choices.map((choice, i) => (
            <View key={i} className="bg-tp-bg-secondary rounded-lg px-3 py-1.5">
              <Text className="text-tp-text-primary text-sm">{choice}</Text>
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
      className="self-start bg-tp-surface border border-tp-warning rounded-card px-4 py-3 max-w-[85%]"
      accessibilityLabel={`Permission required: ${msg.text}${msg.permissionTool ? `, tool: ${msg.permissionTool}` : ""}`}
    >
      <Text className="text-tp-warning text-xs font-bold mb-1">
        Permission Required
      </Text>
      <Text className="text-tp-text-primary text-sm">{msg.text}</Text>
      {msg.permissionTool && (
        <Text className="text-tp-warning text-xs mt-1">
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
