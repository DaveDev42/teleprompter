import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontSizeModal Decrease/Increase used `disabled={atMin}` /
// `disabled={atMax}`, which RN Web maps to native HTML `disabled`. The
// browser skips disabled elements in Tab order, so once the user hit a
// boundary (size = 10 or 24), the matching button vanished from the
// keyboard tour — Shift+Tab from Increase at min jumped straight past
// Decrease to Done, and vice versa. The aria-disabled announcement
// covered by app-aria-disabled is necessary but not sufficient — a
// button you can't reach can't be discovered at all.
// Same fix pattern as the chat Send / pairing Connect / ApiKey Save
// buttons: drop native `disabled`, mirror aria-disabled via ref +
// useEffect, gate the onPress handler so clicks no-op at boundary.
test.describe("FontSize boundary buttons keyboard reachability", () => {
  test("at min, Decrease stays focusable (aria-disabled, not removed from Tab)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByText("Font Size", { exact: true }).first();
    await fontSizeRow.click();

    const decrease = page.getByRole("button", { name: "Decrease font size" });
    const increase = page.getByRole("button", { name: "Increase font size" });
    await expect(decrease).toBeVisible();

    // Drive size down to 10 by clicking Decrease until aria-disabled flips
    // on. Capped to prevent runaway in case of regression.
    for (let i = 0; i < 20; i++) {
      const aria = await decrease.getAttribute("aria-disabled");
      if (aria === "true") break;
      await decrease.click();
    }
    await expect(decrease).toHaveAttribute("aria-disabled", "true");

    // The reachability assertion: focus Increase, then Shift+Tab. The
    // previous focus stop must be the (now boundary-disabled) Decrease
    // button. If RN Web's HTML `disabled` regression came back, the
    // browser would skip Decrease and focus would land on Done instead.
    await increase.focus();
    await page.keyboard.press("Shift+Tab");
    const focusedLabel = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    );
    expect(focusedLabel).toBe("Decrease font size");
  });

  test("at max, Increase stays focusable (aria-disabled, not removed from Tab)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByText("Font Size", { exact: true }).first();
    await fontSizeRow.click();

    const decrease = page.getByRole("button", { name: "Decrease font size" });
    const increase = page.getByRole("button", { name: "Increase font size" });
    await expect(increase).toBeVisible();

    for (let i = 0; i < 30; i++) {
      const aria = await increase.getAttribute("aria-disabled");
      if (aria === "true") break;
      await increase.click();
    }
    await expect(increase).toHaveAttribute("aria-disabled", "true");

    // Forward Tab from Decrease must land on Increase, not skip past it.
    await decrease.focus();
    await page.keyboard.press("Tab");
    const focusedLabel = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    );
    expect(focusedLabel).toBe("Increase font size");
  });
});
