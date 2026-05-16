import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontSizeModal's spinbutton wrapper carries
// role="spinbutton" with aria-valuenow / aria-valuemin / aria-valuemax,
// but does NOT handle the canonical spinbutton keyboard interactions
// (APG Spinbutton Pattern: ArrowUp increments, ArrowDown decrements,
// Home sets minimum, End sets maximum). Without these handlers, AT
// users who discover the spinbutton via Browse/Read mode still cannot
// adjust the font size using the keyboard method that every screen
// reader announces for spinbutton widgets.
//
// Additionally, the spinbutton is missing `aria-valuetext`, which
// conveys the unit ("15 pixels") alongside the numeric value. Without
// it, screen readers announce only the bare numeral ("15") when
// reporting the current value of the spinbutton — the aria-label says
// "in pixels" but the value announcement itself loses the unit when
// announced stand-alone (e.g. on value change via AT-driven increment).
//
// WCAG 4.1.2 Name, Role, Value (Level A): custom widgets must
// programmatically expose their current value and support the expected
// keyboard interaction for their role.
// APG Spinbutton Pattern: https://www.w3.org/WAI/ARIA/apg/patterns/spinbutton/
test.describe("FontSizeModal spinbutton keyboard interaction", () => {
  test("ArrowUp on spinbutton increments font size by one", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Font Size modal
    const fontSizeRow = page
      .getByRole("button")
      .filter({ hasText: /Font Size/i })
      .first();
    await fontSizeRow.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const spinbutton = dialog.getByRole("spinbutton");
    await expect(spinbutton).toBeVisible();

    const initialValue = Number(await spinbutton.getAttribute("aria-valuenow"));

    // APG Spinbutton Pattern: keyboard focus on the spinbutton +
    // ArrowUp must increment the value by one step.
    await spinbutton.focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(200);

    const newValue = Number(await spinbutton.getAttribute("aria-valuenow"));
    expect(newValue).toBe(initialValue + 1);
  });

  test("ArrowDown on spinbutton decrements font size by one", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page
      .getByRole("button")
      .filter({ hasText: /Font Size/i })
      .first();
    await fontSizeRow.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const spinbutton = dialog.getByRole("spinbutton");
    await expect(spinbutton).toBeVisible();

    const initialValue = Number(await spinbutton.getAttribute("aria-valuenow"));

    await spinbutton.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);

    const newValue = Number(await spinbutton.getAttribute("aria-valuenow"));
    expect(newValue).toBe(initialValue - 1);
  });

  test("spinbutton exposes aria-valuetext with pixel unit", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page
      .getByRole("button")
      .filter({ hasText: /Font Size/i })
      .first();
    await fontSizeRow.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const spinbutton = dialog.getByRole("spinbutton");
    await expect(spinbutton).toBeVisible();

    // aria-valuetext must convey the unit so screen readers announce
    // "15 pixels" rather than just the bare numeral "15" when reading
    // the current spinbutton value.
    const valueText = await spinbutton.getAttribute("aria-valuetext");
    expect(valueText).toMatch(/\d+\s*(px|pixels?)/i);
  });
});
