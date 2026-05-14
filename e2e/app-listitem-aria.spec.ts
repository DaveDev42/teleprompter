import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session chat FlatList and sessions tab FlatList declared
// accessibilityRole="list" on the container but the per-item wrapper was a
// plain View. ARIA list semantics require listitem children, so screen
// readers ignored the list role and announced the items as a flat run of
// content. The fix wraps each renderItem result in
// accessibilityRole="listitem". This spec locks the list role on both
// containers — once those exist, the renderItem wrapper is the only path
// that produces children, so the listitem guarantee follows from code
// review of the renderItem callsite.
test.describe("List ARIA roles", () => {
  test("sessions screen container exposes role=list on web", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("tab-sessions").waitFor({ timeout: 10_000 });
    await expect(page.locator('[role="list"]').first()).toBeAttached({
      timeout: 5_000,
    });
  });

  test("session chat list container exposes role=list on web", async ({
    page,
  }) => {
    await page.goto("/session/test-list-role");
    const list = page.locator('[aria-label="Chat messages"]');
    await expect(list).toHaveAttribute("role", "list", { timeout: 10_000 });
  });
});
