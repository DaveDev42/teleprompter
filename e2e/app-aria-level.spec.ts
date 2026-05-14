import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// RN Web maps accessibilityRole="header" → role="heading" but does NOT emit
// aria-level — it must be passed as a direct prop. This regression test
// pins the explicit aria-level={N} pattern on a representative header per
// level (page=1, modal/sub=2, section=3) so a future contributor refactoring
// the helper cannot silently flatten heading hierarchy back to "no level".
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

  test("settings section labels expose aria-level=3", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    // "Appearance" is the first SectionLabel above the theme row.
    const section = page.getByRole("heading", {
      name: "Appearance",
      level: 3,
    });
    await expect(section).toBeVisible();
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
