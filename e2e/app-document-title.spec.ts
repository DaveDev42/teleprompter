import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `document.title` stayed "Teleprompter" on every route.
// Expo Router's `Tabs.Screen` / `Stack.Screen` `title` option only feeds
// the (hidden) native header — it does not propagate to `document.title`
// on web. SR users who switch browser tabs heard the same label for
// every page, violating WCAG 2.4.2 Page Titled (Level A): "Web pages
// have titles that describe topic or purpose."
//
// Fix: drive `document.title` from `usePathname()` in the root layout
// (`apps/app/app/_layout.tsx`) so each route reports a meaningful title.
test.describe("document.title reflects the active route", () => {
  test("Sessions tab title", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/sessions/i);
  });

  test("Daemons tab title", async ({ page }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/daemons/i);
  });

  test("Settings tab title", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/settings/i);
  });

  test("Pairing screen title", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/pairing/i);
  });
});
