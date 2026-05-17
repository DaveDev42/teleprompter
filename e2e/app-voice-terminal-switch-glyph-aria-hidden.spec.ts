import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: the terminal-context toggle in `VoiceButton.tsx` is a
// Pressable with `accessibilityRole="switch"` and
// `accessibilityLabel="Include terminal context"`. Its child <Text>
// renders a bare "T" as a visual abbreviation for sighted users.
//
// role="switch" is NOT atomic in NVDA browse mode / JAWS reading
// cursor — the virtual cursor descends into children, so the bare
// "T" gets verbalized after the switch's accessible name. The user
// hears: "Include terminal context, switch, not checked, T" — the
// trailing "T" duplicates as noise. The accessibilityLabel already
// conveys the action; the "T" is purely decorative.
//
// Native AT (VoiceOver / TalkBack) focuses the parent Pressable and
// reads accessibilityLabel directly, so the gate is web-only. Same
// pattern as the mic button glyph at the bottom of the same file.
// WCAG 1.1.1 (Non-text Content) + 2.5.3 (Label in Name).
//
// Source-level invariant: VoiceButton only renders when a voice API
// key has been set in secure storage. Instead of bootstrapping that
// state, assert the source wraps the "T" <Text> in the same web-gated
// aria-hidden spread.
test("VoiceButton terminal-context T glyph Text spreads web-only aria-hidden in source", () => {
  const filePath = resolve(
    __dirname,
    "../apps/app/src/components/VoiceButton.tsx",
  );
  let body = readFileSync(filePath, "utf-8");

  // Strip JSX block comments and `//` line comments so we don't match
  // prose mentions of the glyph.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Anchor on the terminal-context Pressable. The mic Pressable's
  // onPress is `isActive ? stopVoice : startVoice`, the terminal
  // toggle's is `toggleTerminalContext` — uniquely identifies the
  // terminal switch.
  const switchAnchor = body.indexOf("toggleTerminalContext");
  expect(
    switchAnchor,
    "toggleTerminalContext onPress on terminal switch",
  ).toBeGreaterThan(-1);

  // Walk forward from the Pressable to find the enclosing
  // `</Pressable>` close — everything inside is the switch's subtree.
  const fromSwitch = body.slice(switchAnchor);
  const switchEnd = fromSwitch.indexOf("</Pressable>");
  expect(switchEnd, "closing </Pressable> of terminal switch").toBeGreaterThan(
    -1,
  );
  const switchBody = fromSwitch.slice(0, switchEnd);

  // Inside the terminal switch subtree, find the "T" glyph wrapped in
  // a <Text>. Walk to the `<Text` opening tag and assert the web-gated
  // aria-hidden spread.
  const textTagStart = switchBody.lastIndexOf("<Text");
  expect(textTagStart, "<Text> inside terminal switch").toBeGreaterThan(-1);
  const fromText = switchBody.slice(textTagStart);

  // Find the closing `>` of the open tag at depth 0 (the <Text> is
  // multi-line after the fix: className + spread).
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

  // Defense in depth: the <Text> immediately wraps "T" (single char).
  // Confirm we're looking at the right node.
  const afterOpen = fromText.slice(endIdx + 1);
  const closeIdx = afterOpen.indexOf("</Text>");
  expect(closeIdx, "closing </Text>").toBeGreaterThan(-1);
  const inner = afterOpen.slice(0, closeIdx).trim();
  expect(inner, "Text contents inside terminal switch").toBe("T");
});
