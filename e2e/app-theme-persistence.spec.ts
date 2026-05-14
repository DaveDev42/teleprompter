import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RootLayout had a useEffect that re-resolved the theme on
// system color scheme changes via `setTheme("system")`. On mount, the
// theme store defaults to "system" before the async `load()` reads the
// user's saved preference, so the effect would write "system" to
// secureStorage before load() could read "dark"/"light" — clobbering
// the saved value. Adding a `themeLoaded` gate to the effect prevents
// it from firing before load() completes.

test.describe("Theme preference persists across reload", () => {
  test("setting theme to dark survives a page reload", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Clear any prior persisted theme so the test starts from a known state.
    await page.evaluate(() => {
      localStorage.removeItem("tp_app_theme");
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // The Theme row cycles system → dark → light → system on each tap.
    // Tap until storage records "dark" (at most 3 cycles).
    const themeButton = page.getByText(/^Theme$/).first();
    for (let i = 0; i < 3; i++) {
      const current = await page.evaluate(() =>
        localStorage.getItem("tp_app_theme"),
      );
      if (current === "dark") break;
      await themeButton.click();
      await page.waitForTimeout(150);
    }

    const beforeReload = await page.evaluate(() =>
      localStorage.getItem("tp_app_theme"),
    );
    expect(beforeReload).toBe("dark");

    await page.reload();
    await page.waitForLoadState("networkidle");
    // load() is async — wait for the effect chain to settle.
    await page.waitForTimeout(500);

    const afterReload = await page.evaluate(() =>
      localStorage.getItem("tp_app_theme"),
    );
    expect(afterReload).toBe("dark");
  });
});
