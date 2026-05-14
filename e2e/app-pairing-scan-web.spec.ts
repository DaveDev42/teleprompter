import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: on web, /pairing/scan used to render a "Go Back" Pressable with
// no accessibilityRole/Label and no tabIndex/focus class. Screen readers saw
// just a div, and keyboard users couldn't tell the focused element was
// actionable. Make sure the web fallback exposes a real role=button +
// aria-label and joins the web tab order with the shared focus class.
test.describe("Pairing scan web fallback accessibility", () => {
  test("Go Back exposes role=button and aria-label", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");
    const button = page.getByRole("button", { name: /^Go back$/i });
    await expect(button).toBeVisible();
  });

  test("Go Back is keyboard-reachable via Tab", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
    });

    let found = false;
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("aria-label") || el?.innerText?.trim() || "";
      });
      if (/go back/i.test(label)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  // Regression: arriving at /pairing/scan on web left focus on <body>, so a
  // screen reader user landed on the dead-end fallback with nothing
  // announced. Mount-time focus shifts to Go Back (the only action) so the
  // screen reader speaks the page state and a keyboard user can press
  // Enter without first hunting for the control.
  test("Go Back receives focus on mount", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    // Wait briefly for the rAF-deferred focus to fire.
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-testid") ===
        "scan-web-go-back",
      undefined,
      { timeout: 3_000 },
    );
  });
});
