import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: /pairing/scan web fallback used `router.back()` unconditionally.
// When a user lands here via deep link (or refreshes the page), there's no
// history entry, so the "Go Back" button is a no-op and strands the user on
// a dead-end screen. Guard with router.canGoBack() and fall back to the
// sessions tab.
test.describe("Pairing scan back nav (no history)", () => {
  test("Go Back navigates to sessions tab when there is no history", async ({
    page,
  }) => {
    await page.goto("/pairing/scan");
    const back = page.getByRole("button", { name: /^Go back$/i });
    await back.waitFor({ timeout: 10_000 });
    await back.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
    await page.getByTestId("tab-sessions").waitFor({ timeout: 5_000 });
  });
});
