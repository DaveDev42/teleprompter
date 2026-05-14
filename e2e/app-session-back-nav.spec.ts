import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session screen's back button called router.back()
// unconditionally. When a user lands on /session/:sid via deep link or
// page refresh, expo-router has no history entry to pop, so back() is a
// silent no-op — the user is stranded on the session screen. Fix: fall
// back to router.replace("/(tabs)/") when canGoBack() is false.
test.describe("Session back nav", () => {
  test("back button navigates to sessions tab when no history", async ({
    page,
  }) => {
    await page.goto("/session/test-back-nav");
    const back = page.getByRole("button", { name: "Back to sessions" });
    await back.waitFor({ timeout: 10_000 });
    await back.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
    await page.getByTestId("tab-sessions").waitFor({ timeout: 5_000 });
  });
});
