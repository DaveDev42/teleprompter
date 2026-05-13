import { expect, type Page, test } from "@playwright/test";

// Use mobile viewport so tab bar is visible
test.use({ viewport: { width: 390, height: 844 } });

/**
 * Click a settings row by aria-label via JS evaluate, bypassing the tab bar
 * overlay that intercepts Playwright's native pointer-event-based clicks on
 * mobile viewport. Buttons deeper in the scroll area sit under a fixed tab
 * bar <div>, so JS click is the reliable path.
 */
async function clickSettingsRow(page: Page, ariaLabelPrefix: string) {
  await page.evaluate((prefix) => {
    const btn = Array.from(document.querySelectorAll("[aria-label]")).find(
      (el) => el.getAttribute("aria-label")?.startsWith(prefix),
    ) as HTMLElement | null;
    btn?.click();
  }, ariaLabelPrefix);
}

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

  test("theme toggle cycles through system/dark/light", async ({ page }) => {
    // Default is System for first-time visitors (no stored preference).
    // The store cycle is dark → light → system → dark, so from system
    // we go dark → light → system.
    await expect(page.locator("text=System").first()).toBeVisible();

    // Click Theme row to cycle to Dark (JS click bypasses tab bar overlay)
    await clickSettingsRow(page, "Theme");
    await expect(page.locator("text=Dark").first()).toBeVisible();

    // Click again to cycle to Light
    await clickSettingsRow(page, "Theme");
    await expect(page.locator("text=Light").first()).toBeVisible();

    // Click again back to System
    await clickSettingsRow(page, "Theme");
    await expect(page.locator("text=System").first()).toBeVisible();
  });

  test("diagnostics button exists", async ({ page }) => {
    await expect(page.locator("text=Diagnostics")).toBeVisible();
  });

  test("version is displayed", async ({ page }) => {
    await expect(page.locator("text=/\\d+\\.\\d+\\.\\d+/")).toBeVisible();
  });

  test("font settings are displayed", async ({ page }) => {
    await expect(page.locator("text=Chat Font")).toBeVisible();
    await expect(page.locator("text=Code Font")).toBeVisible();
    await expect(page.locator("text=Terminal Font")).toBeVisible();
    await expect(page.locator("text=Font Size")).toBeVisible();
  });
});
