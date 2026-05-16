import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: both horizontal tablists (the bottom Main navigation tabs
// and the per-session Chat/Terminal tabs) omitted the
// `aria-orientation="horizontal"` attribute. WAI-ARIA 1.2 §6.6.21 says
// authors SHOULD declare the orientation; without it, JAWS treats the
// tablist as vertical and expects ArrowUp/ArrowDown to switch tabs.
// Our keydown handlers only listen for ArrowLeft/ArrowRight (the
// horizontal pattern), so JAWS users couldn't reach the inactive tabs
// at all — a hard WCAG 2.1.1 (Keyboard, Level A) failure because the
// inactive tabs are `tabindex=-1` (roving tabindex) and Arrow keys are
// the only path to them.
//
// Fixes:
//  - bottom tablist: `_layout.tsx` imperative sync sets
//    `aria-orientation="horizontal"` alongside the existing
//    aria-label / aria-owns publication.
//  - session view tablist: `session/[sid].tsx` `tablistWebProps`
//    declares `aria-orientation: "horizontal"` so RN Web emits it.
test.describe("Tablists declare aria-orientation=horizontal", () => {
  test("Bottom navigation tablist is horizontal", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const tablist = page.locator(
      '[role="tablist"][aria-label="Main navigation"]',
    );
    await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
  });

  test("Session view tablist is horizontal", async ({ page }) => {
    await page.goto("/session/test-tablist-orientation");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });
    const tablist = page.locator('[role="tablist"][aria-label="Session view"]');
    await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
  });
});
