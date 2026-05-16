import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the size number in FontSizeModal used to be a bare RN
// <Text> with `accessibilityRole="text"` + `accessibilityLabel`. RN
// Web emits Text as a role-less <div>, and per ARIA spec, aria-label
// on a role-less element is silently ignored — so pressing +/- moved
// the visual number but a screen reader user heard nothing. The fix
// wraps the number in a `role=status` / `aria-live=polite` /
// `aria-atomic=true` container so the new value is announced when
// it changes.
test.describe("FontSize +/- announcement", () => {
  test("size container exposes role=status with polite live region", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByText("Font Size", { exact: true }).first();
    await fontSizeRow.click();

    // The size display is the only role=status node inside the modal —
    // sit on that to avoid matching live regions outside the modal
    // (toasts, disconnect banner, etc.).
    const sizeRegion = page.locator('[role="status"][aria-label^="Font size"]');
    await expect(sizeRegion).toBeVisible();
    await expect(sizeRegion).toHaveAttribute("aria-live", "polite");
    // aria-atomic is set imperatively (RN Web 0.21 prop-passthrough
    // bug). Verify it reaches the DOM so assistive tech re-reads the
    // whole container when the size flips, instead of just the diff.
    await expect(sizeRegion).toHaveAttribute("aria-atomic", "true");

    // The initial label encodes the current size in pixels — sanity
    // check the format before we drive it.
    const initialLabel = await sizeRegion.getAttribute("aria-label");
    expect(initialLabel).toMatch(/^Font size \d+ pixels$/);
  });

  test("Increase updates the announced size", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByText("Font Size", { exact: true }).first();
    await fontSizeRow.click();

    const sizeRegion = page.locator('[role="status"][aria-label^="Font size"]');
    await expect(sizeRegion).toBeVisible();

    const before = await sizeRegion.getAttribute("aria-label");
    const beforeMatch = before?.match(/^Font size (\d+) pixels$/);
    expect(beforeMatch).not.toBeNull();
    const beforeSize = Number(beforeMatch?.[1]);

    const increase = page.getByRole("button", { name: "Increase font size" });
    await increase.click();

    // aria-label updates with the new value; aria-atomic ensures the
    // whole container is re-read by AT on change.
    await expect(sizeRegion).toHaveAttribute(
      "aria-label",
      `Font size ${beforeSize + 1} pixels`,
    );
  });
});
