import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { copyText } from "../lib/copy-text";
import { getPlatformProps } from "../lib/get-platform-props";
import type { ChatMessage } from "../stores/chat-store";
import { useSettingsStore } from "../stores/settings-store";

// ─── Inline markdown parser ──────────────────────────────────────────────────

type InlineSeg =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string }
  | { t: "link"; s: string; href: string };

/** Split a line into bold/italic/code/plain inline segments.
 *  Recognises `**bold**`, `__bold__`, `*italic*`, `_italic_`, and `` `code` ``.
 *
 *  Underscore emphasis requires non-word characters (or string edges) on
 *  the outside of the delimiter — otherwise identifiers like `tool_name`
 *  or `session_id` would be captured as italic across the snake_case
 *  boundary. Asterisk emphasis has no such restriction since `*` doesn't
 *  appear inside identifiers in practice. */
function parseInline(raw: string): InlineSeg[] {
  // Order matters: link `[text](url)` is matched before emphasis so the
  // brackets/parens don't get re-interpreted. Only http(s):// and mailto:
  // URLs are permitted — keeps the regex tight and avoids accidental link
  // construction from text that happens to contain `(...)` after a `[...]`.
  const INLINE_RE =
    /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)|\*\*[\s\S]+?\*\*|(?<![A-Za-z0-9_])__[\s\S]+?__(?![A-Za-z0-9_])|\*[\s\S]+?\*|(?<![A-Za-z0-9_])_[\s\S]+?_(?![A-Za-z0-9_])|`[^`]+`)/g;
  const segs: InlineSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional loop
  while ((m = INLINE_RE.exec(raw)) !== null) {
    if (m.index > last) segs.push({ t: "text", s: raw.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("[")) {
      // [text](href) — split at the boundary between the bracket and paren.
      const close = tok.indexOf("](");
      const text = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      segs.push({ t: "link", s: text, href });
    } else if (tok.startsWith("**"))
      segs.push({ t: "bold", s: tok.slice(2, -2) });
    else if (tok.startsWith("__"))
      segs.push({ t: "bold", s: tok.slice(2, -2) });
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
          case "link":
            return (
              <Text
                key={i}
                className="text-tp-accent underline"
                style={fontStyle}
                // Passing `href` lets RN Web render this as a real <a>, which
                // gives browsers the affordances they expect: right-click
                // "Open in New Tab" / "Copy Link", Cmd+click for a new tab,
                // and a proper context menu. Without href RN Web emits a
                // <div role="link"> that the browser doesn't recognize as a
                // link. `hrefAttrs` adds the standard noopener pair.
                {...(Platform.OS === "web"
                  ? {
                      href: seg.href,
                      hrefAttrs: {
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      // `<a href>` already carries implicit role="link". A
                      // prop-level aria-label="Link: foo" causes NVDA/JAWS
                      // to announce "Link: foo, link" — the role name is
                      // duplicated (WCAG 2.4.6). Let the visible link
                      // text be the accessible name. `title` is in RN
                      // Web's allowed DOM attr list, so it round-trips
                      // to the <a>, giving sighted users a hover preview
                      // and AT users a programmatic description of the
                      // destination URL (replaces the dropped
                      // accessibilityHint).
                      title: seg.href,
                    }
                  : {
                      onPress: () => {
                        Linking.openURL(seg.href).catch(() => {
                          // openURL rejects on unsupported schemes; swallow
                          // so the press isn't a hard crash. The user sees
                          // no-op behavior for malformed URLs, which is
                          // acceptable given the parser already restricts to
                          // http/https/mailto.
                        });
                      },
                      // Native AT (VoiceOver/TalkBack) doesn't infer link
                      // role/URL from an onPress, so keep the explicit
                      // label+hint here. accessibilityRole="link" is
                      // applied below for both branches.
                      accessibilityLabel: `Link: ${seg.s}`,
                      accessibilityHint: `Opens ${seg.href}`,
                    })}
                accessibilityRole="link"
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
  const hasMd =
    /```|^#{1,3}\s|^\s*[-*]\s|^\s*\d+\.\s|\*\*|\*[^*]|`[^`]|\[[^\]]+\]\(/m.test(
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
            // RN Web maps accessibilityRole="header" to role="heading" with an
            // implicit aria-level=2. Pass aria-level explicitly so screen
            // readers see the same heading hierarchy the user sees visually.
            const ariaLevel =
              Platform.OS === "web" ? { "aria-level": block.level } : {};
            return (
              <Text
                key={bi}
                accessibilityRole="header"
                {...(ariaLevel as object)}
                className={hClass}
                style={{ fontFamily: fontStyle?.fontFamily }}
                selectable
              >
                {block.text}
              </Text>
            );
          }
          case "code": {
            // On native the Pressable's onLongPress is the only way to copy
            // the block (no native text-select on a Text inside a Pressable).
            // On web the inner Text is already `selectable`, so keyboard
            // users can Cmd/Ctrl+C after selecting; the Pressable wrapper
            // would otherwise grab a Tab stop with no visible focus ring or
            // discoverable action. Make it non-focusable on web.
            const ppCode = getPlatformProps({ focusable: false });
            return (
              <Pressable
                key={bi}
                className={`bg-tp-bg border border-tp-border rounded-lg px-3 py-2 my-1 ${ppCode.className}`}
                tabIndex={ppCode.tabIndex}
                onLongPress={() => copyText(block.code)}
                accessibilityLabel={`Code block${block.lang ? `, ${block.lang}` : ""}`}
                accessibilityHint={
                  Platform.OS === "web"
                    ? "Select the text to copy"
                    : "Long press to copy"
                }
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
            // WCAG 1.3.1 + ARIA 1.2 §5.3.9: a bulleted/numbered list
            // conveyed only by visual `•` / `1.` glyphs inside generic
            // <div>s fails programmatic determination. role="list" +
            // role="listitem" surface the structure to NVDA/JAWS/VO so
            // users hear "list with N items" and can use list-navigation
            // shortcuts. RN's AccessibilityRole union excludes both
            // roles, so we spread the raw `role` on web only (matching
            // the chat-list / daemons-list ownership patterns).
            const webListProps =
              Platform.OS === "web" ? { role: "list" as const } : {};
            const webListItemProps =
              Platform.OS === "web" ? { role: "listitem" as const } : {};
            return (
              <View key={bi} className="my-0.5" {...webListProps}>
                {block.items.map((item, ii) => (
                  <View
                    key={ii}
                    className="flex-row items-start mb-0.5"
                    {...webListItemProps}
                  >
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
  // ARIA 1.2 §7.1 + WCAG 4.1.2: RN Web's propsToAriaRole maps
  // accessibilityRole="text" to null, so the Pressable emits a generic
  // <div> with no role. `aria-label` on a generic element is prohibited
  // and silently ignored by NVDA/JAWS/VoiceOver — chat bubbles would
  // announce raw text content or nothing, and the long-press copy
  // affordance becomes invisible to AT. The Pressable isn't a real
  // button (no onPress, only onLongPress as a power-user shortcut), so
  // use role="group" with an accessible name — same pattern as
  // DaemonCard in app/(tabs)/daemons.tsx. Spread raw on web because
  // "group" isn't in RN's AccessibilityRole union.
  const a11yLabel = `You: ${msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text}`;
  // WCAG 2.1.1 (Level A): the long-press copy affordance has no keyboard
  // equivalent on web — long-press only fires for pointer events. Wire
  // onPress on web so Enter on a focused bubble triggers the same copy.
  // Native keeps long-press as the discoverable touch gesture.
  // `aria-description` advertises the web-only affordance because RN
  // Web silently drops `accessibilityHint` for non-button roles.
  // RN Web's PressResponder.isValidKeyPress only treats Space as an
  // activation key when the target carries role="button" (isButtonRole
  // check). role="group" misses that branch, so Space lands silently
  // even though Enter activates onPress. WCAG 2.1.1 expects the copy
  // affordance to be reachable via the standard activation keys —
  // mirror the Space handler pattern from VoiceButton.tsx (role=switch)
  // and session/[sid].tsx (role=tab).
  const onKeyDownSpace =
    Platform.OS === "web"
      ? {
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === " ") {
              e.preventDefault();
              copyText(msg.text);
            }
          },
        }
      : {};
  return (
    <Pressable
      className={`self-end bg-tp-user-bubble rounded-bubble rounded-br-sm px-4 py-2.5 max-w-[80%] ${pp.className}`}
      tabIndex={pp.tabIndex}
      onPress={Platform.OS === "web" ? () => copyText(msg.text) : undefined}
      onLongPress={() => copyText(msg.text)}
      accessibilityLabel={a11yLabel}
      accessibilityHint="Long press to copy"
      {...(Platform.OS === "web"
        ? ({
            role: "group",
            "aria-label": a11yLabel,
            "aria-description": "Press Enter or Space to copy",
          } as object)
        : {})}
      {...(onKeyDownSpace as object)}
    >
      <Text
        className="text-tp-text-on-color leading-[22px]"
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
  const pp = getPlatformProps();
  // Skip rendering when the assistant message has no visible content.
  // The PTY-parsing path can land an empty / whitespace-only assistant
  // message (e.g. the Stop hook arrives with last_assistant_message=""
  // after a transport hiccup, or a streaming message is finalized with
  // only whitespace). Rendering an empty bubble leaves a small padded
  // box with no text — looks like a UI glitch and produces an empty
  // "Claude: " announcement for screen readers.
  if (!msg.text.trim()) return null;
  // See UserCard rationale: accessibilityRole="text" → no role on web →
  // aria-label silently ignored on the generic <div>. Use role="group"
  // so the bubble carries a non-generic role and the accessible name +
  // long-press hint actually reach AT.
  const a11yLabel = `Claude: ${msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text}`;
  // See UserCard: WCAG 2.1.1 — copy affordance must be keyboard-reachable
  // on web. Wire onPress and aria-description on web only. The Space
  // handler mirrors UserCard's because RN Web's PressResponder only
  // fires Space on role="button" — role="group" needs an explicit
  // onKeyDown to satisfy the standard activation-key contract.
  const onKeyDownSpace =
    Platform.OS === "web"
      ? {
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === " ") {
              e.preventDefault();
              copyText(msg.text);
            }
          },
        }
      : {};
  return (
    <Pressable
      className={`self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%] ${pp.className}`}
      tabIndex={pp.tabIndex}
      onPress={Platform.OS === "web" ? () => copyText(msg.text) : undefined}
      onLongPress={() => copyText(msg.text)}
      accessibilityLabel={a11yLabel}
      accessibilityHint="Long press to copy"
      {...(Platform.OS === "web"
        ? ({
            role: "group",
            "aria-label": a11yLabel,
            "aria-description": "Press Enter or Space to copy",
          } as object)
        : {})}
      {...(onKeyDownSpace as object)}
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
  // The card only acts as a button when it can actually expand/collapse — i.e.
  // a PostToolUse result whose output exceeds the collapsed line/char budget.
  // Static cards (running tools, short results) must not steal Tab focus on
  // web nor announce as buttons to screen readers.

  // Edit / MultiEdit: render a unified diff instead of raw JSON.
  // MultiEdit nests its hunks under `edits: [{old_string, new_string}, …]`
  // and only carries `file_path` at the top level, so the top-level
  // old_string/new_string check would miss it.
  const editOld = inputObj && asString(inputObj.old_string);
  const editNew = inputObj && asString(inputObj.new_string);
  const multiEdits =
    toolName === "MultiEdit" && inputObj && Array.isArray(inputObj.edits)
      ? (inputObj.edits as unknown[])
          .map((e) => asRecord(e))
          .filter(
            (e): e is Record<string, unknown> =>
              e !== null &&
              asString(e.old_string) !== null &&
              asString(e.new_string) !== null,
          )
          .map((e) => ({
            oldStr: e.old_string as string,
            newStr: e.new_string as string,
          }))
      : null;
  const isEdit =
    (toolName === "Edit" && editOld !== null && editNew !== null) ||
    (multiEdits !== null && multiEdits.length > 0);

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
  const isActionable = isResult && isTruncatable;
  const pp = getPlatformProps({ focusable: isActionable });

  // RN Web's Pressable forwards aria-expanded only when the attribute is
  // passed directly — accessibilityState.expanded is silently dropped
  // (same gap as aria-checked/busy/disabled). The disclosure semantics
  // matter here: SR users rely on aria-expanded to scan a chat for
  // collapsed tool outputs they could open. Spread on web only.
  const ariaExpandedTool =
    Platform.OS === "web" && isActionable ? { "aria-expanded": expanded } : {};

  // When `isActionable` is false (running tool, or short non-truncatable
  // result) the Pressable has no accessibilityRole. RN Web emits a
  // generic <div> in that case, and per ARIA 1.2 §7.1 (Naming
  // Prohibition) aria-label on a role=generic element is dropped by AT.
  // The accessibilityLabel "Tool <name>, running/completed" would be
  // silently invisible — same bug class as BUG-80 for UserCard/
  // AssistantCard. Apply role="group" on web so the label surfaces.
  // Actionable cards already have role=button which is sufficient.
  const ariaGroupTool =
    Platform.OS === "web" && !isActionable ? { role: "group" as const } : {};

  return (
    <Pressable
      onPress={isActionable ? () => setExpanded((v) => !v) : undefined}
      tabIndex={pp.tabIndex}
      className={`self-stretch bg-tp-surface border border-tp-border rounded-card px-3.5 py-2.5 ${pp.className}`}
      accessibilityLabel={`Tool ${toolName}, ${isResult ? "completed" : "running"}${isTruncatable ? `, ${expanded ? "expanded" : "collapsed"}` : ""}`}
      accessibilityRole={isActionable ? "button" : undefined}
      accessibilityHint={
        isActionable
          ? expanded
            ? "Tap to collapse"
            : "Tap to expand full output"
          : undefined
      }
      {...(ariaExpandedTool as object)}
      {...(ariaGroupTool as object)}
    >
      {/* Decorative children: the parent Pressable's accessibilityLabel
          already encodes the tool name + state ("Tool Bash, completed,
          collapsed"), and aria-expanded carries the disclosure state on
          actionable cards. The disclosure glyph (▸/▾) and the status
          badge text (Done/Running) are visual redundancies — exposing
          them to AT produces "BLACK DOWN-POINTING SMALL TRIANGLE" or a
          stray "Done" tail after the group's accessible name. role=group
          isn't atomic for virtual-cursor navigation, so children remain
          reachable unless explicitly hidden. WCAG 1.1.1 (Decorative
          Images / Non-text Content): mark these as aria-hidden on web.
          Native AT reads the Pressable's accessibilityLabel and doesn't
          descend into children for role=group / role=button. */}
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <Text
            className="text-tp-text-tertiary text-xs mr-1.5"
            {...(Platform.OS === "web"
              ? ({ "aria-hidden": true } as object)
              : {})}
          >
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
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
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
      ) : !isResult && msg.toolInput != null && multiEdits ? (
        <View>
          {multiEdits.map((edit, i) => (
            <EditDiff
              key={`${i}-${edit.oldStr.length}-${edit.newStr.length}`}
              oldStr={edit.oldStr}
              newStr={edit.newStr}
              codeFontStyle={codeFontStyle}
            />
          ))}
        </View>
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
        // The expansion state is already conveyed via aria-expanded on the
        // actionable Pressable + the "expanded"/"collapsed" suffix on its
        // accessibilityLabel. Visually labeling the affordance "Show
        // more"/"Show less" is for sighted users; AT users would hear it
        // a second time after the button's name. Hide it on web. Native
        // AT reads only the parent button's accessibilityLabel.
        <Text
          className="text-tp-accent text-[11px] mt-1.5"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        >
          {expanded ? "Show less" : "Show more"}
        </Text>
      ) : null}
    </Pressable>
  );
}

function SystemCard({ msg }: { msg: ChatMessage }) {
  // Errors (StopFailure) need to be visually distinct from informational
  // notifications — they signal that the assistant response failed and the
  // user may need to retry. Use the error color and a leading warning glyph.
  const isError = msg.event === "StopFailure";
  // Announce StopFailure to screen readers so users aren't silently stuck on
  // a chat that visually shows an error. Mirrors PermissionCard — role=alert
  // already implies aria-live="assertive" per ARIA 1.2 §6.3.3, so don't set
  // an explicit accessibilityLiveRegion: a "polite" value would land as
  // aria-live="polite" and *override* the implicit assertive (ARIA 1.2
  // §6.2.1), silently downgrading the failure announcement to a queued
  // background message. Plain system notifications stay silent (no live
  // region) — there can be many of them per session and making each one
  // shout would drown out the conversation.
  return (
    <View
      className="self-center py-1 px-3 max-w-full"
      {...(isError
        ? {
            accessibilityRole: "alert" as const,
            accessibilityLabel: `Error: ${msg.text}`,
          }
        : {})}
    >
      <Text
        className={`text-xs text-center ${
          isError ? "text-tp-error font-medium" : "text-tp-text-tertiary"
        }`}
        selectable
        // role=alert on the parent View already names the bubble via
        // accessibilityLabel="Error: ${msg.text}", but role=alert is NOT
        // atomic for virtual-cursor traversal — NVDA/JAWS can still descend
        // into this child Text and announce "warning sign" before the
        // message body, doubling the announcement after the alert label has
        // already played. Hide the child from AT on web for the error case.
        // Native AT reads the parent alert and does not descend. WCAG 1.1.1.
        {...(Platform.OS === "web" && isError
          ? ({ "aria-hidden": true } as object)
          : {})}
      >
        {isError ? `⚠ ${msg.text}` : msg.text}
      </Text>
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
  // RN Web's createDOMProps strips prop-level `aria-atomic` when spread
  // on a <View>. role=status has implicit aria-atomic=true per ARIA
  // 1.2 §6.3.2, but NVDA/JAWS historically ignore the implicit value
  // and announce only the diff between successive `msg.text` updates —
  // each PTY chunk would speak as a fragment instead of the full
  // streaming line. Set aria-atomic imperatively on the DOM node so
  // every update is announced atomically.
  const liveRegionRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = liveRegionRef.current as unknown as HTMLElement | null;
    if (el) el.setAttribute("aria-atomic", "true");
  }, []);

  return (
    // accessibilityRole="text" → no role on web, so the "Claude is
    // typing" aria-label is silently dropped (same UserCard/AssistantCard
    // issue). Use role=status so the typing indicator announces as a
    // polite live region — exactly the semantics we want for a transient
    // "still typing…" hint.
    <View
      ref={liveRegionRef}
      className="self-start bg-tp-assistant-bubble rounded-bubble rounded-tl-sm px-4 py-2.5 max-w-[80%] opacity-70"
      accessibilityLabel="Claude is typing"
      {...(Platform.OS === "web"
        ? ({ role: "status", "aria-label": "Claude is typing" } as object)
        : {})}
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
  // role=alert already implies aria-live="assertive" per ARIA 1.2 §6.3.3.
  // Setting accessibilityLiveRegion="polite" would emit aria-live="polite"
  // which *overrides* the implicit assertive (ARIA 1.2 §6.2.1) — Claude
  // waiting on user input would get queued behind in-flight speech and
  // the user might miss it entirely. PermissionCard correctly uses
  // assertive; this card matches that intent now.
  return (
    <View
      className="self-start bg-tp-surface border border-tp-accent rounded-card px-4 py-3 max-w-[85%]"
      accessibilityRole="alert"
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
  // role=alert already implies aria-live="assertive" AND aria-atomic="true"
  // per ARIA 1.2 §6.3.3. An explicit accessibilityLiveRegion="assertive"
  // emits aria-live="assertive" which, per ARIA 1.2 §6.2.1, *overrides* the
  // implicit live-region properties — including dropping the implicit
  // aria-atomic=true. The result is that NVDA/JAWS announce only the
  // mutated text portion instead of the full "Permission required: …"
  // label. Match SystemCard/ElicitationCard: lean on the implicit
  // properties of role=alert.
  return (
    <View
      className="self-start bg-tp-surface border border-tp-warning rounded-card px-4 py-3 max-w-[85%]"
      accessibilityRole="alert"
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
