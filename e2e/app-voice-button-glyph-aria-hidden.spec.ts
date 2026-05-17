import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: the mic button in `VoiceButton.tsx` renders either
// "■" (U+25A0 BLACK SQUARE, when listening/connecting) or "Mic"
// (when idle) as a bare <Text> child. role="button" is NOT atomic
// in NVDA browse mode / JAWS reading cursor — the virtual cursor
// descends into children, so the glyph or text gets verbalized as
// "black square" / "Mic" after the button's accessibleName, polluting
// the announcement.
//
// The mic button's accessibleName is set on the parent Pressable via
// accessibilityLabel="Stop voice, …" / "Start voice input". The inner
// <Text> must additionally carry aria-hidden=true on web. Native AT
// focuses the parent Pressable and reads accessibilityLabel directly,
// so the gate is web-only. WCAG 1.1.1 (Non-text Content) +
// WCAG 2.5.3 (Label in Name).
//
// Source-level invariant: VoiceButton only renders when a voice API
// key has been set in secure storage, which is awkward to seed
// reliably in CI. Instead of bootstrapping that state, assert the
// source wraps the glyph <Text> in the same web-gated aria-hidden
// spread used by every other decorative glyph fix in this codebase.
test("VoiceButton mic glyph Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(
    __dirname,
    "../apps/app/src/components/VoiceButton.tsx",
  );
  let body = readFileSync(filePath, "utf-8");

  // Strip JSX block comments and `//` line comments so we don't
  // match prose mentions of the glyph.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Find the "■" literal — the active-state mic glyph.
  const glyphIndex = body.indexOf("■");
  expect(glyphIndex, "mic stop glyph in VoiceButton JSX").toBeGreaterThan(-1);

  // Walk backwards to the enclosing `<Text` open tag.
  const beforeGlyph = body.slice(0, glyphIndex);
  const textTagStart = beforeGlyph.lastIndexOf("<Text");
  expect(textTagStart, "enclosing <Text> for mic glyph").toBeGreaterThan(-1);

  // The mic <Text> is multi-line (className + aria-hidden spread).
  // Find the closing `>` of the open tag at depth 0.
  const fromText = body.slice(textTagStart);
  let depth = 0;
  let endIdx = -1;
  for (let i = 0; i < fromText.length; i++) {
    const ch = fromText[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      endIdx = i;
      break;
    }
  }
  expect(endIdx, "open <Text> tag terminator").toBeGreaterThan(-1);
  const openTag = fromText.slice(0, endIdx + 1);

  // Assert the open tag carries the web-gated aria-hidden spread.
  expect(openTag).toMatch(
    /Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/,
  );
});
