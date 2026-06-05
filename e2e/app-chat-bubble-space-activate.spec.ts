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
// The Space handler lives in the shared `useCopyAffordance` hook
// (`apps/app/src/components/use-copy-affordance.ts`): a web-only
// `onKeyDown` that fires `copyText(text)` when `e.key === " "`. Both
// cards call `useCopyAffordance(msg.text)` and spread the resulting
// `onKeyDown` onto the Pressable.
//
// chat-store is in-memory and cannot be seeded from Playwright CI, so
// the guard runs at the source level: assert (1) the hook defines the
// web-only Space onKeyDown→copyText handler, and (2) both UserCard and
// AssistantCard consume the hook and wire its onKeyDown. A
// defense-in-depth DOM check on the live page verifies no rendered
// bubble breaks the contract (vacuously true today, blocks future
// regressions).

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

test.describe("Chat bubbles activate copy on Space on web", () => {
  test("useCopyAffordance defines a web-only Space onKeyDown to copyText", () => {
    const hook = readSource(HOOK_PATH);

    const nonCommentLines = hook.split("\n").filter((line) => {
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
      /onKeyDown[\s\S]{0,200}?key\s*===\s*["'](?: |Space)["'][\s\S]{0,200}?copyText\(text\)/,
    );
  });

  test("UserCard consumes useCopyAffordance and wires its onKeyDown", () => {
    const code = cardCode(readSource(CHATCARD_PATH), "UserCard");

    expect(code).toMatch(/useCopyAffordance\(msg\.text\)/);
    // Must wire the hook's onKeyDown onto the Pressable so Space copies.
    expect(code).toMatch(/copy\.onKeyDown/);
  });

  test("AssistantCard consumes useCopyAffordance and wires its onKeyDown", () => {
    const code = cardCode(readSource(CHATCARD_PATH), "AssistantCard");

    expect(code).toMatch(/useCopyAffordance\(msg\.text\)/);
    expect(code).toMatch(/copy\.onKeyDown/);
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
