import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Diagnostics panel was a full-screen state swap, not a
// real modal. (a) Escape didn't close it because no global key handler was
// wired, and (b) clicking "Done" left focus on <body> because the trigger
// SettingsRow was unmounted-and-remounted across the swap. Keyboard users
// lost their place every time.
test.describe("Diagnostics panel a11y", () => {
  test("Escape closes the Diagnostics panel and returns focus", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.click();

    // Panel header should be visible.
    const done = page.getByRole("button", { name: /^Done$/ });
    await expect(done).toBeVisible({ timeout: 5_000 });

    // Press Escape — the panel should close.
    await page.keyboard.press("Escape");
    await expect(done).toBeHidden({ timeout: 5_000 });

    // Focus should return to the Diagnostics trigger row.
    const focusedLabel = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    expect(focusedLabel).toBe("Diagnostics");
  });

  test("opening moves focus into the panel", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();

    // Focus should land on the Done button — it's the panel's anchor.
    // Without focus-on-open, keyboard users get dumped onto the tab bar
    // because the trigger row unmounts during the state swap.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.activeElement?.getAttribute("aria-label") ?? null,
          ),
        { timeout: 2_000 },
      )
      .toBe("Done");
  });

  test("Done button restores focus to the Diagnostics row", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();

    const done = page.getByRole("button", { name: /^Done$/ });
    await expect(done).toBeVisible({ timeout: 5_000 });
    await done.click();

    await expect(done).toBeHidden({ timeout: 5_000 });
    const focusedLabel = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    expect(focusedLabel).toBe("Diagnostics");
  });
});
