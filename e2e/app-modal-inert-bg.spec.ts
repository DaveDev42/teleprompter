import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: when a ModalContainer opened, the background app tree
// (including #root) had neither `inert` nor `aria-hidden`. Screen readers
// could virtual-cursor through the background and assistive Tab could
// (per RN Web bypass) escape the dialog. The component now walks from the
// dialog up to <body> and marks every off-path sibling inert+aria-hidden,
// restoring on close.
test.describe("Modal background inert", () => {
  test("Font Size modal inerts background siblings on open", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Font Size modal
    const fontSizeRow = page
      .getByRole("button", { name: /Font Size/i })
      .first();
    await fontSizeRow.click();
    const dialog = page.locator('[role="dialog"][aria-label="Font Size"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The app's #root container is the modal's grandparent (siblings of the
    // modal overlay chain) — verify at least one off-path background element
    // carries inert.
    const inertBackgroundCount = await page.evaluate(() => {
      return document.querySelectorAll(
        '[inert]:not([role="dialog"]):not([role="dialog"] *)',
      ).length;
    });
    expect(inertBackgroundCount).toBeGreaterThan(0);

    // Closing the modal removes inert from the background.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    const remainingInert = await page.evaluate(() => {
      return document.querySelectorAll("[inert]").length;
    });
    expect(remainingInert).toBe(0);
  });

  test("OpenAI API Key modal inerts background siblings on open", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const apiKeyRow = page
      .getByRole("button", { name: /OpenAI API Key|API Key/i })
      .first();
    await apiKeyRow.click();
    const dialog = page.locator('[role="dialog"][aria-label="OpenAI API Key"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const inertBackgroundCount = await page.evaluate(() => {
      return document.querySelectorAll(
        '[inert]:not([role="dialog"]):not([role="dialog"] *)',
      ).length;
    });
    expect(inertBackgroundCount).toBeGreaterThan(0);
  });
});
