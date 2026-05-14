import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: opening a session with no relay connection used to leave the
// user with no visual signal that sending wouldn't work — pressing Enter
// silently no-op'd while the placeholder still said "Send a message...".
// A persistent banner above the chat now explains the state.
test.describe("Session disconnect banner (no relay connection)", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("tp_")) localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    });
  });

  test("disconnected banner shown on a live session view", async ({ page }) => {
    await page.goto("/session/test-disconnect-banner");
    await page.waitForLoadState("networkidle");

    const banner = page.getByTestId("session-disconnected-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/disconnect/i);
  });
});
