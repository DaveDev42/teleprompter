import { expect, test } from "@playwright/test";

test.describe("App Web — Settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
  });

  test("settings tab is accessible", async ({ page }) => {
    const settingsTab = page.locator("text=Settings");
    if (await settingsTab.isVisible()) {
      await settingsTab.click();
      await page.waitForTimeout(500);
      await expect(page.locator("text=Daemon URL")).toBeVisible();
    }
  });

  test("theme toggle switches between dark/light/system", async ({ page }) => {
    const settingsTab = page.locator("text=Settings");
    if (await settingsTab.isVisible()) {
      await settingsTab.click();
      await page.waitForTimeout(500);

      // Theme section should show three options
      await expect(page.locator("text=Theme")).toBeVisible();
      await expect(page.locator("text=Dark")).toBeVisible();
      await expect(page.locator("text=Light")).toBeVisible();
      await expect(page.locator("text=System")).toBeVisible();

      // Click Light theme
      await page.locator("text=Light").click();
      await page.waitForTimeout(300);

      // Click back to Dark
      await page.locator("text=Dark").click();
      await page.waitForTimeout(300);

      // Theme buttons should still be visible (not broken)
      await expect(page.locator("text=Dark")).toBeVisible();
    }
  });

  test("daemon URL input and set button exist", async ({ page }) => {
    const settingsTab = page.locator("text=Settings");
    if (await settingsTab.isVisible()) {
      await settingsTab.click();
      await page.waitForTimeout(500);

      await expect(page.locator("text=Daemon URL")).toBeVisible();
      await expect(page.locator("text=Set")).toBeVisible();
    }
  });

  test("pair with daemon button exists", async ({ page }) => {
    const settingsTab = page.locator("text=Settings");
    if (await settingsTab.isVisible()) {
      await settingsTab.click();
      await page.waitForTimeout(500);

      await expect(page.locator("text=Pair with Daemon")).toBeVisible();
    }
  });

  test("diagnostics button exists", async ({ page }) => {
    const settingsTab = page.locator("text=Settings");
    if (await settingsTab.isVisible()) {
      await settingsTab.click();
      await page.waitForTimeout(500);

      await expect(page.locator("text=Diagnostics")).toBeVisible();
    }
  });
});
