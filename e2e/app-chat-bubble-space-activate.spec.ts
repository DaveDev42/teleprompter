import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `UserCard` / `AssistantCard` render the chat bubble as a
// Pressable with `role="group"` on web. RN Web's
// PressResponder.isValidKeyPress only treats Space as an activation key
// when the target carries role="button" (the `isButtonRole` check at
// `react-native-web/src/modules/usePressEvents/PressResponder.js`). So
// Enter on a focused bubble fires the copy `onPress` (via Pressable's
// synthetic onClick), but Space falls through silently — keyboard-only
// and screen reader users who default to Space as the activation key
// can't copy the bubble.
//
// WCAG 2.1.1 Keyboard (Level A): all functionality available via one
// key must also be reachable via the standard keyboard activation
// pattern. Both Enter and Space are the standard pair for interactive
// elements. Mirror the Space handler pattern from `VoiceButton.tsx`
// (role=switch — `app-voice-switch-space-toggle.spec.ts`) and the
// session view's Chat/Terminal tabs (role=tab —
// `app-session-tabs-space-activate.spec.ts`).
//
// chat-store is in-memory and cannot be seeded from Playwright CI, so
// the guard runs at the source level: assert both UserCard and
// AssistantCard contain a web-only onKeyDown handler that calls
// copyText on Space. A defense-in-depth DOM check on the live page
// verifies no rendered bubble breaks the contract (vacuously true
// today, blocks future regressions).
test.describe("Chat bubbles activate copy on Space on web", () => {
  test("UserCard wires a web-only Space onKeyDown to copyText", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function UserCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function UserCard".length;
    const next = source.slice(after).match(/^function /m);
    expect(next).not.toBeNull();
    const nextOffset = next?.index ?? 0;
    const end = after + nextOffset;
    const body = source.slice(start, end);

    const nonCommentLines = body.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    // Must guard the handler on web only — native uses long-press and
    // RN's PressResponder there already covers Space for buttons.
    expect(code).toMatch(/Platform\.OS\s*===\s*["']web["']/);
    // Must define an onKeyDown that fires copyText when the key is
    // Space. Allow `" "` or `'Space'` recognition forms.
    expect(code).toMatch(
      /onKeyDown[\s\S]{0,200}?key\s*===\s*["'](?: |Space)["'][\s\S]{0,200}?copyText\(msg\.text\)/,
    );
  });

  test("AssistantCard wires a web-only Space onKeyDown to copyText", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function AssistantCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function AssistantCard".length;
    const next = source.slice(after).match(/^function /m);
    expect(next).not.toBeNull();
    const nextOffset = next?.index ?? 0;
    const end = after + nextOffset;
    const body = source.slice(start, end);

    const nonCommentLines = body.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    expect(code).toMatch(/Platform\.OS\s*===\s*["']web["']/);
    expect(code).toMatch(
      /onKeyDown[\s\S]{0,200}?key\s*===\s*["'](?: |Space)["'][\s\S]{0,200}?copyText\(msg\.text\)/,
    );
  });

  // Defense in depth: scan the live app for any bubble (role="group"
  // with the You:/Claude: name pattern) and assert the aria-description
  // mentions Space alongside Enter so AT users learn the new activator.
  // chat-store is empty in CI so this is vacuously true today; the
  // assertion blocks a future regression where someone adds bubbles
  // without updating the description.
  test("rendered chat bubbles advertise Space activation in aria-description", async ({
    page,
  }) => {
    await page.goto("/session/test-chat-bubble-space-activate");
    await page.waitForLoadState("networkidle");

    const offenders = await page.evaluate(() => {
      const result: Array<{ label: string | null; desc: string | null }> = [];
      for (const el of Array.from(
        document.querySelectorAll('[role="group"][aria-label]'),
      )) {
        const label = el.getAttribute("aria-label");
        if (!label || !/^(You:|Claude:)/.test(label)) continue;
        const desc = el.getAttribute("aria-description") ?? "";
        if (!/[Ss]pace/.test(desc)) result.push({ label, desc });
      }
      return result;
    });

    expect(offenders).toEqual([]);
  });
});
