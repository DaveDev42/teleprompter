import { expect, test } from "@playwright/test";

// Use mobile viewport so tab bar is visible
test.use({ viewport: { width: 390, height: 844 } });

test.describe("App Web — Settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });
    // Navigate to Settings tab
    await page.locator("text=Settings").last().click();
    await page.waitForSelector("text=Appearance", { timeout: 5_000 });
  });

  test("settings tab shows appearance section", async ({ page }) => {
    await expect(page.locator("text=Appearance")).toBeVisible();
    await expect(page.locator("text=Theme")).toBeVisible();
  });

  test("theme toggle cycles through dark/light/system", async ({ page }) => {
    // Default is Dark
    await expect(page.locator("text=Dark")).toBeVisible();

    // Click Theme row to cycle to Light
    await page.locator("text=Theme").click();
    await expect(page.locator("text=Light")).toBeVisible();

    // Click again to cycle to System
    await page.locator("text=Theme").click();
    await expect(page.locator("text=System")).toBeVisible();

    // Click again back to Dark
    await page.locator("text=Theme").click();
    await expect(page.locator("text=Dark")).toBeVisible();
  });

  test("diagnostics button exists", async ({ page }) => {
    await expect(page.locator("text=Diagnostics")).toBeVisible();
  });

  test("version is displayed", async ({ page }) => {
    await expect(page.locator("text=0.1.0")).toBeVisible();
  });

  test("font settings are displayed", async ({ page }) => {
    await expect(page.locator("text=Chat Font")).toBeVisible();
    await expect(page.locator("text=Code Font")).toBeVisible();
    await expect(page.locator("text=Terminal Font")).toBeVisible();
    await expect(page.locator("text=Font Size")).toBeVisible();
  });
});
