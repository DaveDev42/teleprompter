import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// RN Web maps accessibilityRole="header" → role="heading" but does NOT emit
// aria-level — it must be passed as a direct prop. This regression test
// pins the explicit aria-level={N} pattern on page-level headers so a
// future contributor refactoring the helper cannot silently flatten
// heading hierarchy back to "no level". Per-screen section-level coverage
// lives in app-settings-heading-levels.spec.ts (level 2 in Settings).
test.describe("Heading aria-level", () => {
  test("page headers expose aria-level=1", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const sessions = page.getByRole("heading", {
      name: "Sessions",
      level: 1,
    });
    await expect(sessions).toBeVisible();
  });

  test("settings page header exposes aria-level=1", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const settings = page.getByRole("heading", {
      name: "Settings",
      level: 1,
    });
    await expect(settings).toBeVisible();
  });

  test("pairing screen header exposes aria-level=1", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const pair = page.getByRole("heading", {
      name: "Pair with Daemon",
      level: 1,
    });
    await expect(pair).toBeVisible();
  });
});
