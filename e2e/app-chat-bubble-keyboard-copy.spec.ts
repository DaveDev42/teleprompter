import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `UserCard` and `AssistantCard` in
// `apps/app/src/components/ChatCard.tsx` render a chat bubble that is
// keyboard Tab-reachable (`getPlatformProps()` defaults `tabIndex=0`)
// but defines only `onLongPress` for the "copy bubble text" affordance
// — no `onPress`. RN Web's PressResponder only fires `onLongPress`
// from a pointer timer; keyboard Enter/Space on the focused bubble
// goes nowhere. Web AT users can also not discover the copy
// affordance because `accessibilityHint="Long press to copy"` is
// silently dropped by RN Web on `role="group"` elements (no
// aria-description bridge).
//
// Fix: the copy affordance lives in the shared `useCopyAffordance`
// hook (`apps/app/src/components/use-copy-affordance.ts`). It wires
// `onPress = Platform.OS === "web" ? () => copyText(text) : undefined`
// so Enter on a focused bubble runs the same copy path long-press
// fires on touch, and exposes `aria-description="Press Enter or Space
// to copy"` on web so the affordance is announceable. Both cards call
// `useCopyAffordance(msg.text)` and spread its props onto the
// Pressable. Native keeps long-press as the touch gesture and
// `accessibilityHint` keeps working on native AT.
//
// WCAG 2.1.1 Keyboard (Level A): all functionality must be operable
// via keyboard. WCAG 4.1.2 Name, Role, Value (Level A): the copy
// affordance must be programmatically determinable.
//
// The guard runs at the source level because chat-store is in-memory
// and cannot be seeded from Playwright CI. It asserts two things: (1)
// the hook holds the actual a11y contract (web onPress→copyText +
// aria-description), and (2) both cards consume the hook and wire its
// onPress onto the bubble. A live DOM check (defense in depth) blocks
// future regressions where a rendered bubble drops aria-description.

const HOOK_PATH = "../apps/app/src/components/use-copy-affordance.ts";
const CHATCARD_PATH = "../apps/app/src/components/ChatCard.tsx";

function readSource(relPath: string): string {
  return readFileSync(resolve(__dirname, relPath), "utf8");
}

// Extract a top-level function body from ChatCard.tsx, stripping
// comment lines so assertions match code, not prose.
function cardCode(source: string, fnName: string): string {
  const start = source.indexOf(`function ${fnName}`);
  expect(start).toBeGreaterThan(0);
  const after = start + `function ${fnName}`.length;
  const next = source.slice(after).match(/^function /m);
  expect(next).not.toBeNull();
  const end = after + (next?.index ?? 0);
  const body = source.slice(start, end);
  const nonCommentLines = body.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*");
  });
  return nonCommentLines.join("\n");
}

test.describe("Chat bubbles expose keyboard copy action on web", () => {
  test("useCopyAffordance wires web-only onPress to copyText and aria-description", () => {
    const hook = readSource(HOOK_PATH);

    const nonCommentLines = hook.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    // The hook must gate the copy affordance on web only.
    expect(code).toMatch(/Platform\.OS\s*===\s*["']web["']/);
    // onPress must run copyText(text) on web (and stay undefined on
    // native, where long-press is the discoverable gesture).
    expect(code).toMatch(
      /onPress\s*=\s*isWeb\s*\?\s*\(\)\s*=>\s*copyText\(text\)/,
    );
    // The web a11y props must carry an aria-description mentioning
    // Enter so the affordance is announceable to AT.
    expect(code).toMatch(/"aria-description"\s*:\s*["'][^"']*[Ee]nter/);
  });

  test("UserCard consumes useCopyAffordance and wires its onPress", () => {
    const code = cardCode(readSource(CHATCARD_PATH), "UserCard");

    // Must derive the affordance from the shared hook with the bubble
    // text...
    expect(code).toMatch(/useCopyAffordance\(msg\.text\)/);
    // ...and wire its onPress onto the Pressable so Enter copies.
    expect(code).toMatch(/onPress=\{copy\.onPress\}/);
    // ...plus spread the web a11y props (aria-description lives there).
    expect(code).toMatch(/\.\.\.copy\.webGroupProps/);
  });

  test("AssistantCard consumes useCopyAffordance and wires its onPress", () => {
    const code = cardCode(readSource(CHATCARD_PATH), "AssistantCard");

    expect(code).toMatch(/useCopyAffordance\(msg\.text\)/);
    expect(code).toMatch(/onPress=\{copy\.onPress\}/);
    expect(code).toMatch(/\.\.\.copy\.webGroupProps/);
  });

  // Defense in depth: scan the live app and assert that any rendered
  // chat bubble (role="group" with the You:/Claude: name pattern) on
  // web carries an aria-description. chat-store is in-memory so this
  // is vacuously true today but blocks future regressions.
  test("any rendered chat bubble carries aria-description on web", async ({
    page,
  }) => {
    await page.goto("/session/test-chat-bubble-keyboard-copy");
    await page.waitForLoadState("networkidle");

    const offenders = await page.evaluate(() => {
      const result: Array<{ label: string | null; desc: string | null }> = [];
      for (const el of Array.from(
        document.querySelectorAll('[role="group"][aria-label]'),
      )) {
        const label = el.getAttribute("aria-label");
        if (!label || !/^(You:|Claude:)/.test(label)) continue;
        const desc = el.getAttribute("aria-description");
        if (!desc) result.push({ label, desc });
      }
      return result;
    });

    expect(offenders).toEqual([]);
  });
});
