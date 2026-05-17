import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: `EditDiff` in `apps/app/src/components/ChatCard.tsx`
// renders a `-` Text in front of each deleted line and a `+` Text in
// front of each added line. Both prefix Texts encode the diff
// direction visually via color (tp-error / tp-success); the line
// content lives in a separate sibling Text.
//
// `EditDiff` is rendered inside `ToolCard`, whose outer wrapper has
// `role="button"` (actionable) or `role="group"` (non-actionable) —
// both are NOT atomic in NVDA browse mode / JAWS reading cursor. The
// virtual cursor descends through every child Text, so the bare "-" /
// "+" prefixes are read as "hyphen-minus" / "plus sign" between every
// line, fragmenting the diff readout for AT users.
//
// Native AT (VoiceOver / TalkBack) focuses the ToolCard wrapper and
// reads accessibilityLabel ("Tool Edit, completed") directly without
// descending, so the gate is web-only. Same pattern as the ▸/▾,
// "Done", "Show more/less" decorative Texts in ToolCard.
// WCAG 1.1.1.
//
// Source-level invariant: ToolCard/EditDiff only render when a tool
// event has been delivered by the daemon — not seedable in CI. Assert
// the EditDiff function body wraps the "-" and "+" prefix Texts in
// the canonical web-gated aria-hidden spread.

const ARIA_HIDDEN_SPREAD =
  /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/;

function extractFunctionBody(source: string, fnName: string): string {
  const start = source.indexOf(`function ${fnName}`);
  expect(start, `${fnName} declaration`).toBeGreaterThan(0);
  const after = start + `function ${fnName}`.length;
  const next = source
    .slice(after)
    .match(/^(?:export\s+(?:default\s+)?)?function /m);
  expect(next, `function following ${fnName}`).not.toBeNull();
  const nextOffset = next?.index ?? 0;
  const end = after + nextOffset;
  return source.slice(start, end);
}

function stripComments(body: string): string {
  let code = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");
  code = code
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return code;
}

// Find the <Text> open tag whose immediate body is exactly the given
// single-character literal (after trimming surrounding whitespace).
function findOpenTagForChild(code: string, child: string): string {
  // Walk every `<Text` opening; for each, find its `</Text>` close at
  // matching depth and check whether the trimmed inner content equals
  // the target char. Return the opening tag of the first match.
  let cursor = 0;
  while (cursor < code.length) {
    const tagStart = code.indexOf("<Text", cursor);
    if (tagStart < 0) break;
    // Skip `<TextInput` if it ever appears — not a Text node.
    const peek = code.slice(tagStart, tagStart + 10);
    if (/^<Text[A-Za-z]/.test(peek)) {
      cursor = tagStart + 5;
      continue;
    }
    const fromTag = code.slice(tagStart);
    // Find the closing `>` of the open tag at JSX brace depth 0.
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < fromTag.length; i++) {
      const ch = fromTag[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        endIdx = i;
        break;
      }
    }
    if (endIdx < 0) break;
    const openTag = fromTag.slice(0, endIdx + 1);

    // Find the matching `</Text>`. EditDiff doesn't nest <Text>, so
    // the first `</Text>` after the open tag is the close.
    const afterOpen = fromTag.slice(endIdx + 1);
    const closeIdx = afterOpen.indexOf("</Text>");
    if (closeIdx < 0) break;
    const inner = afterOpen.slice(0, closeIdx).trim();
    if (inner === child) return openTag;

    cursor = tagStart + endIdx + 1;
  }
  return "";
}

test("EditDiff '-' / '+' prefix Texts spread web-only aria-hidden in source", () => {
  const source = readFileSync(
    resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
    "utf8",
  );
  const body = extractFunctionBody(source, "EditDiff");
  const code = stripComments(body);

  const minusOpenTag = findOpenTagForChild(code, "-");
  expect(minusOpenTag, "<Text>-</Text> open tag in EditDiff").not.toBe("");

  const plusOpenTag = findOpenTagForChild(code, "+");
  expect(plusOpenTag, "<Text>+</Text> open tag in EditDiff").not.toBe("");

  for (const [name, tag] of [
    ["minus prefix", minusOpenTag],
    ["plus prefix", plusOpenTag],
  ] as const) {
    const hasInline = ARIA_HIDDEN_SPREAD.test(tag);
    const hasHelperSpread = /\{\.\.\.ariaHiddenWeb\}/.test(tag);
    expect(
      hasInline || hasHelperSpread,
      `${name} <Text> missing web-only aria-hidden: ${tag}`,
    ).toBe(true);
  }

  // If the helper-variable pattern is used, verify the helper itself
  // is gated on Platform.OS === "web" so native AT keeps reading.
  if (/\{\.\.\.ariaHiddenWeb\}/.test(code)) {
    const helperDecl = code.match(/ariaHiddenWeb\s*=[\s\S]{0,200}?;/);
    expect(helperDecl, "ariaHiddenWeb declaration").not.toBeNull();
    expect(helperDecl?.[0] ?? "").toMatch(ARIA_HIDDEN_SPREAD);
  }
});
