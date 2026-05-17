import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `UserCard`, `AssistantCard`, and `StreamingCard` in
// `apps/app/src/components/ChatCard.tsx` declared
// `accessibilityRole="text"` on their bubble wrappers.
//
// RN Web's `propsToAriaRole` (node_modules/react-native-web/src/modules/
// AccessibilityUtil/propsToAriaRole.js line ~22) maps `"text"` to `null`,
// which causes the `role` attribute to be **omitted entirely** — the
// Pressable / View renders as a generic <div>.
//
// Per WAI-ARIA 1.2 §7.1 (Naming Prohibition) + WCAG 4.1.2 (Name, Role,
// Value, Level A), `aria-label` is *prohibited* on `role="generic"`
// elements and is silently ignored by NVDA/JAWS/VoiceOver. So every
// chat bubble's `accessibilityLabel="You: …"` / `"Claude: …"` /
// `"Claude is typing"` plus the `accessibilityHint="Long press to copy"`
// affordance reach the DOM as `aria-label` / `aria-labelledby` but are
// dropped by AT — screen-reader users get NO accessible name for chat
// messages at all.
//
// Fix: use `role="group"` (UserCard/AssistantCard, since they're
// non-interactive content containers with a long-press shortcut) and
// `role="status"` (StreamingCard, since it's a transient "typing…"
// indicator) on web. The labels then survive translation to ARIA.
//
// chat-store is in-memory (no localStorage), so we can't seed messages
// from Playwright. Defense in depth:
//   1. Source-level invariant: ChatCard.tsx must not reference
//      `accessibilityRole="text"` anywhere — the canonical fix is to
//      drop the offending role string entirely. Catches regressions
//      that wouldn't render in the empty CI session.
//   2. DOM-level invariant on every route: any element whose
//      `aria-label` matches a chat-bubble pattern must carry a
//      non-empty `role` attribute. Empty CI sessions render no
//      bubbles, so this is trivially satisfied today but bites the
//      moment a future test seeds messages or a real session lands.

test.describe("Chat bubbles emit a non-generic ARIA role", () => {
  test('ChatCard.tsx no longer uses accessibilityRole="text"', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );
    // Match real JSX usage but ignore comment lines that *document*
    // why the role is wrong — leading `//` or `*` markers are comments
    // and don't reach the bundle. The canonical fix drops the
    // `accessibilityRole="text"` attribute, replacing it with a
    // web-only spread of `role="group"` (UserCard/AssistantCard) or
    // `role="status"` (StreamingCard).
    const offendingLines = source.split("\n").filter((line) => {
      if (!/accessibilityRole=["']text["']/.test(line)) return false;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return true;
    });
    expect(offendingLines).toEqual([]);
  });

  const routesToScan = [
    "/",
    "/daemons",
    "/settings",
    "/pairing",
    "/pairing/scan",
    "/session/test-chat-bubble-role-invariant",
  ];

  for (const route of routesToScan) {
    test(`chat-bubble aria-label carries a non-generic role on ${route}`, async ({
      page,
    }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const violations = await page.evaluate(() => {
        const labelPattern = /^(You: |Claude: |Claude is typing)/;
        return Array.from(document.querySelectorAll("[aria-label]"))
          .filter((el) =>
            labelPattern.test(el.getAttribute("aria-label") ?? ""),
          )
          .filter((el) => {
            const role = el.getAttribute("role");
            return role === null || role === "" || role === "generic";
          })
          .map((el) => ({
            label: el.getAttribute("aria-label"),
            role: el.getAttribute("role"),
            outerHTMLPrefix: el.outerHTML.slice(0, 160),
          }));
      });

      expect(violations).toEqual([]);
    });
  }
});
