import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontSizeModal renders a numeric stepper (+/- buttons) for
// adjusting chat font size, but the numeric value element has no
// `role="spinbutton"` and no `aria-valuenow` / `aria-valuemin` /
// `aria-valuemax` attributes. WCAG 4.1.2 (Name, Role, Value, Level A)
// requires custom widgets to programmatically expose their role and
// value state. Without spinbutton semantics, a screen reader user knows
// only that two buttons exist — they never hear the current value (15),
// the range (10–24), or the unit (px). The live region (role=status)
// announces changes reactively but doesn't surface the range upfront
// when focus lands on the control for the first time.
//
// Fix: wrap the − / value / + group in a View with role="spinbutton",
// aria-valuenow={size}, aria-valuemin={MIN}, aria-valuemax={MAX}, and
// aria-label="Font size in pixels". The − / + Pressables keep
// role="button" for activation; the spinbutton wrapper is the semantic
// container AT reads for value state. On web the spinbutton can also
// respond to ArrowUp / ArrowDown so assistive-technology users can
// adjust the value with keyboard — matching the APG Spinbutton Pattern.
test.describe("FontSizeModal spinbutton semantics", () => {
  test("font size control exposes role=spinbutton with aria-valuenow/min/max", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the Font Size modal
    const fontSizeRow = page
      .getByRole("button")
      .filter({ hasText: /Font Size/i })
      .first();
    await fontSizeRow.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The numeric stepper must expose role=spinbutton so AT announces
    // "15, spinbutton, minimum 10, maximum 24" when focused.
    const spinbutton = dialog.getByRole("spinbutton");
    await expect(spinbutton).toBeVisible();

    // aria-valuenow must reflect the current size (default 15px)
    const valueNow = await spinbutton.getAttribute("aria-valuenow");
    expect(Number(valueNow)).toBeGreaterThanOrEqual(10);
    expect(Number(valueNow)).toBeLessThanOrEqual(24);

    // aria-valuemin and aria-valuemax must expose the full range
    await expect(spinbutton).toHaveAttribute("aria-valuemin", "10");
    await expect(spinbutton).toHaveAttribute("aria-valuemax", "24");
  });
});
