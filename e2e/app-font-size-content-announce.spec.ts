import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the FontSizeModal live region used `aria-label="Font size
// {size} pixels"` on the role=status container, but the region's text
// content was a bare number ("16"). ARIA live region announcements use
// the region's TEXT CONTENT, not its `aria-label` — the label is the
// accessible name for focus-context, and it does not fire on content
// changes. A screen reader pressing +/- on font size heard only "16",
// "17", … with no unit or label, failing WCAG 4.1.3 (status messages
// must convey purpose). The fix puts the prefix/unit text inside the
// live region (visually hidden) so the announced content is "Font size
// 16 pixels" while the visible UI still shows just the large number.
test.describe("Font size live region announcement content", () => {
  test("Font size live region text content includes the 'pixels' unit", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await page.getByText("Font Size", { exact: true }).first().click();

    const sizeRegion = page
      .locator('[role="status"]')
      .filter({ hasText: /\d/ })
      .first();
    await expect(sizeRegion).toBeVisible();

    const textContent = await sizeRegion.evaluate(
      (el) => el.textContent?.trim() ?? "",
    );

    // The text content (what AT announces on change) must include the
    // unit, not just a bare number.
    expect(textContent.toLowerCase()).toContain("pixel");
    expect(textContent.toLowerCase()).toContain("font size");
  });
});
