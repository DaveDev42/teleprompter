import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: the session view's Back button in
// `apps/app/app/session/[sid].tsx` (testID="session-back") renders a
// `‹ Sessions` `<Text>` as a direct child of a Pressable with
// `accessibilityLabel="Back to sessions"`. The parent's aria-label
// replaces the accessible name on focus, but `role="button"` is NOT
// atomic for virtual-cursor navigation in NVDA browse mode / JAWS
// reading cursor — the cursor descends into the child Text and
// announces "single left-pointing angle quotation mark Sessions"
// after the button's name, doubling the announcement.
//
// WCAG 1.1.1 (Non-text Content, Level A): the glyph + text node are
// decorative — the accessibilityLabel already conveys the action.
// Hide from AT on web. Native AT (VoiceOver/TalkBack) focuses the
// Pressable and reads accessibilityLabel directly, so the gate is
// web-only.
//
// Source-level invariant — mirrors the chat-send-glyph and back-nav
// spec patterns. There's only one `‹` glyph in this file (the back
// button); the enclosing <Text> opening tag must spread the canonical
// web-gated aria-hidden.
test("Session Back button glyph Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(__dirname, "../apps/app/app/session/[sid].tsx");
  let body = readFileSync(filePath, "utf-8");

  // Strip JSX block comments `{/* ... */}` so explanatory comments
  // (which may reference the glyph in prose) don't get matched as the
  // JSX literal. Multiline-aware.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip line comments too.
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Find the "‹" literal in the remaining JSX. After comment stripping
  // there should be exactly one — the back button glyph.
  const glyphIndex = body.indexOf("‹");
  expect(glyphIndex, "back-button glyph in [sid].tsx JSX").toBeGreaterThan(-1);

  // Walk backwards to the enclosing `<Text` open tag.
  const beforeGlyph = body.slice(0, glyphIndex);
  const textTagStart = beforeGlyph.lastIndexOf("<Text");
  expect(textTagStart, "enclosing <Text> for ‹").toBeGreaterThan(-1);

  // The Text renders the glyph + label as the only child. The first
  // `>\n` after `<Text` is the close of the opening tag.
  const afterTextTag = body.slice(textTagStart);
  const openTagEnd = afterTextTag.indexOf(">\n");
  expect(openTagEnd, "open <Text> tag terminator").toBeGreaterThan(-1);
  const openTag = afterTextTag.slice(0, openTagEnd);

  // Assert the open tag carries the web-gated aria-hidden spread.
  expect(openTag).toMatch(
    /Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/,
  );
});
