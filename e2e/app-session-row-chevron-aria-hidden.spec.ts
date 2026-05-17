import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: `SessionRow` in `apps/app/app/(tabs)/index.tsx` renders a
// trailing `›` (U+203A) chevron `<Text>` to signal "tappable" to sighted
// users. The parent Pressable has `accessibilityLabel` (→ `aria-label`
// on web), but `role="button"` is NOT atomic for virtual-cursor
// navigation in NVDA browse mode / JAWS reading cursor — the cursor
// descends into the child Text and announces "right pointing angle
// quotation mark" after every session row, polluting the announcement.
//
// WCAG 1.1.1 (Non-text Content, Level A): the chevron is decorative —
// the accessibilityLabel already conveys the action. Hide from AT on
// web. Native AT (VoiceOver/TalkBack) focuses the Pressable and reads
// accessibilityLabel directly, so the gate is web-only.
//
// Source-level invariant: the CI build serves `apps/app/dist` without
// any daemon, so `SessionRow` is never rendered (the Sessions list is
// always empty). Instead, assert that the source code wraps the `›`
// `<Text>` in a `Platform.OS === "web" ? { "aria-hidden": true } : {}`
// spread, matching the same pattern as the SettingsRow chevron fix
// (BUG-101).
test("SessionRow chevron Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(
    __dirname,
    "../apps/app/app/(tabs)/index.tsx",
  );
  const raw = readFileSync(filePath, "utf-8");

  // Slice the SessionRow function body. The function declaration
  // signature is `function SessionRow(`. Take from there to the first
  // `}` followed by a closing `;` line (component body ends with the
  // Pressable's closing tag and the function's `}`). We do this so we
  // only assert on the SessionRow component, not on anything else in
  // the file.
  const rowFnStart = raw.indexOf("function SessionRow(");
  expect(rowFnStart, "SessionRow function declaration").toBeGreaterThan(-1);
  // End at the next top-level `function ` declaration or `export
  // default function` (which is `SessionsScreen` below).
  const rowFnEnd = raw.indexOf(
    "export default function SessionsScreen",
    rowFnStart,
  );
  expect(rowFnEnd, "SessionsScreen follows SessionRow").toBeGreaterThan(
    rowFnStart,
  );
  let body = raw.slice(rowFnStart, rowFnEnd);

  // Strip JSX block comments `{/* ... */}` so the explanatory comment
  // (which itself contains the `›` glyph) doesn't get matched as the
  // JSX literal. Multiline-aware.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip line comments too.
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Find the `›` literal in the remaining JSX. There should be exactly
  // one occurrence after stripping comments — the chevron Text node.
  const glyphIndex = body.indexOf("›");
  expect(glyphIndex, "chevron glyph in SessionRow JSX").toBeGreaterThan(-1);

  // Walk backwards to find the enclosing `<Text` open tag.
  const beforeGlyph = body.slice(0, glyphIndex);
  const textTagStart = beforeGlyph.lastIndexOf("<Text");
  expect(textTagStart, "enclosing <Text> for chevron").toBeGreaterThan(-1);

  // The Text element's attributes are between `<Text` and the
  // immediately following `>` that closes the open tag.
  const afterTextTag = body.slice(textTagStart);
  // Find the end of the opening tag — first `>` that is not part of a
  // `=>` arrow or inside a quoted string. Simpler heuristic: scan for
  // `\n        >` or `>` followed by newline then `›`. The component
  // renders the glyph as the only child, so the first `>` after the
  // attribute spread is the opening-tag close.
  const openTagEnd = afterTextTag.indexOf(">\n");
  expect(openTagEnd, "open <Text> tag terminator").toBeGreaterThan(-1);
  const openTag = afterTextTag.slice(0, openTagEnd);

  // Assert the open tag carries the web-gated aria-hidden spread.
  expect(openTag).toMatch(
    /Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/,
  );
});
