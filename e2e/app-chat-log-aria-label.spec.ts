import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Bug: The session view wraps the chat transcript in `role="log"` so
// assistive technology announces appended messages automatically, but the
// log landmark carries no accessible name. Per WCAG 2.4.6 (AA) and ARIA
// 1.2 §6.3.14, landmarks used as navigation targets should have an
// accessible name so screen reader users can distinguish the region when
// browsing by landmark (e.g. "Chat log" vs. an anonymous log). Without
// `aria-label="Chat log"` (or equivalent aria-labelledby), VoiceOver on
// macOS announces only "log" and NVDA skips the region entirely in
// landmark mode — the user cannot jump directly into the chat transcript.
//
// The fix is to add `aria-label="Chat log"` to the outer log `<View>`
// in app/session/[sid].tsx (inside the `liveRegionProps` web spread).
test.describe("Session chat log accessible name", () => {
  test("role=log landmark has an accessible name on web", async ({ page }) => {
    await page.goto("/session/test-chat-log-aria-label");
    await page.waitForLoadState("networkidle");

    const log = page.locator('[role="log"]');
    await expect(log).toBeVisible();

    // The log landmark must carry an accessible name so AT users can
    // reach it by landmark navigation and know what it contains.
    // Either aria-label or aria-labelledby must be present.
    const ariaLabel = await log.getAttribute("aria-label");
    const ariaLabelledby = await log.getAttribute("aria-labelledby");

    expect(
      ariaLabel || ariaLabelledby,
      "role=log should have aria-label or aria-labelledby for landmark navigation",
    ).toBeTruthy();
  });
});
