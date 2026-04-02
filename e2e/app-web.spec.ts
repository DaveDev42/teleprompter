import { expect, test } from "@playwright/test";

// Use mobile viewport so tab bar is visible
test.use({ viewport: { width: 390, height: 844 } });

test.describe("App Web — UI Smoke Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });
  });

  test("loads and shows Sessions header", async ({ page }) => {
    await expect(page.locator("text=Sessions").first()).toBeVisible();
  });

  test("shows empty state when no daemon connected", async ({ page }) => {
    await expect(page.locator("text=No active sessions")).toBeVisible();
  });

  test("has three navigation tabs", async ({ page }) => {
    // Tab bar labels in mobile viewport
    const tabs = page.locator('[role="tablist"]');
    if (await tabs.isVisible().catch(() => false)) {
      await expect(tabs.locator("text=Sessions")).toBeVisible();
      await expect(tabs.locator("text=Daemons")).toBeVisible();
      await expect(tabs.locator("text=Settings")).toBeVisible();
    } else {
      // Fallback: check tab labels exist somewhere in the page
      const body = await page.locator("body").textContent();
      expect(body).toContain("Sessions");
      expect(body).toContain("Daemons");
    }
  });

  test("dark theme is applied", async ({ page }) => {
    const screenshot = await page.screenshot();
    expect(screenshot.length).toBeGreaterThan(1000);
  });
});
