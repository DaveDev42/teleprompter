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
// Fix: wire `onPress={Platform.OS === "web" ? () => copyText(msg.text)
// : undefined}` on both cards so Enter on a focused bubble runs the
// same copy path that long-press fires on touch. Add
// `aria-description="Press Enter to copy"` on web so the affordance
// is announceable. Native keeps long-press as the touch gesture and
// `accessibilityHint` keeps working on native AT.
//
// WCAG 2.1.1 Keyboard (Level A): all functionality must be operable
// via keyboard. WCAG 4.1.2 Name, Role, Value (Level A): the copy
// affordance must be programmatically determinable.
test.describe("Chat bubbles expose keyboard copy action on web", () => {
  test("UserCard wires web-only onPress to copyText and aria-description", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function UserCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function UserCard".length;
    const next = source.slice(after).match(/^function /m);
    expect(next).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const end = after + (next!.index ?? 0);
    const body = source.slice(start, end);

    const nonCommentLines = body.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    // Must wire onPress on web — pattern is Platform.OS === "web" ?
    // () => copyText(msg.text) : undefined.
    expect(code).toMatch(
      /onPress=\{Platform\.OS\s*===\s*["']web["']\s*\?\s*\(\)\s*=>\s*copyText\(msg\.text\)/,
    );
    // Must spread aria-description literal on the web branch.
    expect(code).toMatch(/"aria-description"\s*:\s*["'][^"']*[Ee]nter/);
  });

  test("AssistantCard wires web-only onPress to copyText and aria-description", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function AssistantCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function AssistantCard".length;
    const next = source.slice(after).match(/^function /m);
    expect(next).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const end = after + (next!.index ?? 0);
    const body = source.slice(start, end);

    const nonCommentLines = body.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    expect(code).toMatch(
      /onPress=\{Platform\.OS\s*===\s*["']web["']\s*\?\s*\(\)\s*=>\s*copyText\(msg\.text\)/,
    );
    expect(code).toMatch(/"aria-description"\s*:\s*["'][^"']*[Ee]nter/);
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
