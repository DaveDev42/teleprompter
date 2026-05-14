import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Settings → About → Updates row uses a visual status
// pill (UpdateStatusValue) instead of plain text for its value, and the
// row's aria-label only said "Updates". Screen readers therefore lost
// the actual status ("Dev build", "Up to date", "Update available",
// etc.). Fix composes the spoken label as "Updates, <status>".
test.describe("Settings Updates row a11y", () => {
  test("aria-label includes the OTA status text", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Appearance").waitFor({ timeout: 10_000 });

    // The "Dev build" status renders when running outside an EAS-managed
    // build (which is always the case for the static dist bundle the
    // Playwright fixture serves).
    const row = page.locator('[aria-label="Updates, Dev build"]');
    await expect(row).toBeAttached({ timeout: 5_000 });
  });
});
