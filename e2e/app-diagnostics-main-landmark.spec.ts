import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: opening Diagnostics dropped the `role="main"` landmark from
// the page. The Settings tab uses an early-return branch
// (`if (showDiagnostics) return <View>...`) that replaces the entire
// subtree, so the `role="main"` on the normal Settings `<ScrollView>`
// (PR #360) doesn't carry across. AT users navigating by landmark
// (NVDA/JAWS/VoiceOver) lost their jump target the moment the panel
// mounted, mid-flow.
//
// Fix mirrors the normal-branch pattern: spread `role="main"` (web-only)
// on the Diagnostics root View as well. WCAG 2.4.1 Bypass Blocks
// (Level A) + ARIA 1.2 §6.3.19 main landmark.
test.describe("Settings → Diagnostics preserves role=main landmark", () => {
  test("role=main remains after opening and after closing Diagnostics", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Baseline: the plain Settings screen has exactly one role=main.
    await expect.poll(() => page.locator('[role="main"]').count()).toBe(1);

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const done = page.getByRole("button", { name: /^Done$/ });
    await expect(done).toBeVisible({ timeout: 5_000 });

    // Invariant: the early-return Diagnostics branch must keep the
    // landmark. Pre-fix this asserted 0; post-fix it stays 1.
    await expect.poll(() => page.locator('[role="main"]').count()).toBe(1);

    await done.click();
    await expect(done).toBeHidden({ timeout: 5_000 });

    // And restored cleanly on close.
    await expect.poll(() => page.locator('[role="main"]').count()).toBe(1);
  });
});
