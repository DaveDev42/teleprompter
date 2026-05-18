import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Settings tab rows were only addressable by their
// visible label (`getByRole("button", { name: /Theme/ })` etc), so a
// copy tweak quietly broke ~20 e2e specs at once. Each tappable row now
// carries a stable `data-testid` so future selectors don't depend on
// English label text. This spec just pins the IDs so removals get
// caught by CI instead of by an unrelated spec going red.
test.describe("Settings rows expose stable testIDs", () => {
  test("each settings row has its data-testid attached", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Tab order: Sessions (index 0) → Daemons (1) → Settings (2)
    await page.getByTestId("tab-settings").click();

    for (const id of [
      "settings-row-theme",
      "settings-row-chat-font",
      "settings-row-code-font",
      "settings-row-terminal-font",
      "settings-row-font-size",
      "settings-row-api-key",
      "settings-row-version",
      "settings-row-updates",
      "settings-row-diagnostics",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });
});
