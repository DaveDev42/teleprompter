import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: navigating directly to /session/:sid (deep link, browser
// refresh) left document.activeElement === document.body. Keyboard and
// screen-reader users were dropped onto the page with no announced focus
// point and had to press Tab blindly to find an anchor. Fix moves focus
// to the Back button on mount (rAF-deferred so RN Web has the DOM node).
test.describe("Session initial focus", () => {
  test("Back button receives focus on first mount", async ({ page }) => {
    await page.goto("/session/test-initial-focus");
    await page.waitForLoadState("networkidle");

    // Wait for the Back button to render, then verify focus landed on it
    // (rAF runs the focus call after RN Web mounts the DOM node).
    const back = page.getByTestId("session-back");
    await expect(back).toBeVisible();

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.getAttribute("data-testid") ?? null;
          }),
        { timeout: 3_000 },
      )
      .toBe("session-back");
  });
});
