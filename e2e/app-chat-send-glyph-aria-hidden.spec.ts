import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: the chat composer Send button in
// `apps/app/app/session/[sid].tsx` renders a `↑` (U+2191 UPWARDS ARROW)
// `<Text>` as a direct child of a Pressable with
// `accessibilityLabel="Send message"`. The parent's `aria-label`
// replaces the accessible name on focus, but `role="button"` is NOT
// atomic for virtual-cursor navigation in NVDA browse mode / JAWS
// reading cursor — the cursor descends into the child Text and
// announces "upwards arrow" after the button's name, polluting the
// readout.
//
// WCAG 1.1.1 (Non-text Content, Level A): the glyph is decorative —
// the accessibilityLabel already conveys the action. Hide from AT on
// web. Native AT (VoiceOver/TalkBack) focuses the Pressable and reads
// accessibilityLabel directly, so the gate is web-only.
//
// Source-level invariant: the session view renders against a session
// row that doesn't exist in CI's empty store, so the Send button's
// glyph isn't in the live DOM. Instead, assert the source code wraps
// the `↑` `<Text>` in the canonical web-gated `aria-hidden` spread,
// matching the same pattern as the SettingsRow / SessionRow chevron
// and FontSizeModal ± glyph fixes.
test("Chat Send button glyph Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(__dirname, "../apps/app/app/session/[sid].tsx");
  let body = readFileSync(filePath, "utf-8");

  // Strip JSX block comments `{/* ... */}` so the explanatory comment
  // (which itself contains the `↑` glyph in prose) doesn't get matched
  // as the JSX literal. Multiline-aware.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip line comments too.
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Find the "↑" literal in the remaining JSX. After comment stripping
  // there should be exactly one — the Send button glyph.
  const glyphIndex = body.indexOf("↑");
  expect(glyphIndex, "send-button glyph in [sid].tsx JSX").toBeGreaterThan(-1);

  // Walk backwards to the enclosing `<Text` open tag.
  const beforeGlyph = body.slice(0, glyphIndex);
  const textTagStart = beforeGlyph.lastIndexOf("<Text");
  expect(textTagStart, "enclosing <Text> for ↑").toBeGreaterThan(-1);

  // The Text renders the glyph as the only child. The first `>\n` after
  // `<Text` is the close of the opening tag.
  const afterTextTag = body.slice(textTagStart);
  const openTagEnd = afterTextTag.indexOf(">\n");
  expect(openTagEnd, "open <Text> tag terminator").toBeGreaterThan(-1);
  const openTag = afterTextTag.slice(0, openTagEnd);

  // Assert the open tag carries the web-gated aria-hidden spread.
  expect(openTag).toMatch(
    /Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/,
  );
});
