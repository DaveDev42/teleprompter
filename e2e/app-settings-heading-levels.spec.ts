import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: Settings section labels (Appearance / Voice / About) were
// emitted as aria-level=3 directly under the level=1 "Settings" heading,
// skipping level 2. "Headings only" navigation in screen readers
// announces "level 3" with no parent level 2, which is disorienting and
// fails WCAG 2.4.6 advisory. The fix lowers them to level 2.
test.describe("Settings heading levels", () => {
  test("section labels are aria-level=2 (no skipped levels)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const sections = ["Appearance", "Voice", "About"];
    for (const name of sections) {
      const heading = page.getByRole("heading", { name });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveAttribute("aria-level", "2");
    }
  });
});
