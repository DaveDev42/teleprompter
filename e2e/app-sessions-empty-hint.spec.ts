import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// Regression guard: the empty-state hint must describe a path the user can
// actually take with the keys their hardware exposes. The "Go to Daemons"
// CTA in the empty state is intentionally tabIndex=-1 (otherwise it grabs
// Tab 1 ahead of the persistent tab bar — react-navigation renders the bar
// after the scene in DOM order). For keyboard-only users, the documented
// path is "open the Daemons tab below" via the bottom navigation.
//
// Previously the hint said "Start a new session from the Daemons tab or
// run tp on your machine." with no anchor for keyboard users — the source
// comment at index.tsx claimed the path was "also documented in the
// instructional text above" but the text didn't actually say that.

test.describe("Sessions empty state — keyboard-friendly hint", () => {
  test("hint mentions opening the Daemons tab as the action", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("text=No active sessions", { timeout: 30_000 });

    // Hint text must reference the Daemons tab as a navigable destination,
    // not just an abstract "Daemons tab" — and must include the local-tp
    // fallback for users without a paired daemon.
    const hint = page.getByText(/Open the Daemons tab/);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/run tp/);
  });

  test('"Go to Daemons" CTA is still mouse-clickable', async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=No active sessions", { timeout: 30_000 });

    const cta = page.getByRole("button", { name: "Go to Daemons" });
    await expect(cta).toBeVisible();
    await cta.click();
    await page.waitForURL(/\/daemons$/, { timeout: 5_000 });
  });
});
