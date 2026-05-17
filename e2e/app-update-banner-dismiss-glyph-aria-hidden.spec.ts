import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: `UpdateBanner` in `apps/app/src/components/UpdateBanner.tsx`
// wraps its content in a `View` with `role="alert"` (web). `role="alert"`
// announcements are computed from raw DOM textContent (not from
// descendant accessible names), so a bare `✕` (U+2715 MULTIPLICATION X)
// `<Text>` inside the alert gets verbalized by NVDA/JAWS/VoiceOver as
// "times" / "x" / "multiplication sign" after the banner message,
// polluting the update announcement.
//
// The dismiss button's accessible name is set on the parent Pressable
// via `accessibilityLabel="Dismiss update banner"`, but that doesn't
// reach the alert region's flattening, so the glyph must additionally
// carry `aria-hidden=true` on web. Native AT focuses the parent
// Pressable and reads accessibilityLabel directly, so the gate is
// web-only. WCAG 1.1.1 (Non-text Content) + 4.1.3 (Status Messages).
//
// Source-level invariant: `UpdateBanner` only renders when
// `status === "ready"`, which requires live OTA state unavailable in
// CI. Instead of trying to seed the OTA state, assert that the source
// wraps the `✕` `<Text>` in the same web-gated `aria-hidden` spread
// used by the InAppToast dismiss glyph fix (BUG-98).
test("UpdateBanner dismiss glyph Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(
    __dirname,
    "../apps/app/src/components/UpdateBanner.tsx",
  );
  let body = readFileSync(filePath, "utf-8");

  // Strip JSX block comments `{/* ... */}` so the explanatory comment
  // doesn't get matched as the JSX literal. Multiline-aware.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip line comments too (some `//` lines reference the glyph in
  // prose).
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Find the "✕" literal in the remaining JSX. After comment stripping
  // there should be exactly one — the dismiss button glyph.
  const glyphIndex = body.indexOf("✕");
  expect(glyphIndex, "dismiss glyph in UpdateBanner JSX").toBeGreaterThan(-1);

  // Walk backwards to the enclosing `<Text` open tag.
  const beforeGlyph = body.slice(0, glyphIndex);
  const textTagStart = beforeGlyph.lastIndexOf("<Text");
  expect(textTagStart, "enclosing <Text> for ✕").toBeGreaterThan(-1);

  // The Text element renders the glyph as the only child. The first
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
