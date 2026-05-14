import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ghostty-web mounts internal tabIndex=0 elements (a hidden
// textarea + an a11y mirror div) inside the terminal container. Plain Tab
// cycles between those two forever — keyboard users get trapped inside
// the Terminal tab with no way out, even via Shift+Tab. The fix
// intercepts Tab on the container and moves focus to the next/previous
// focusable outside.
test.describe("Terminal tab keyboard escape", () => {
  test("Tab from inside terminal moves focus to a non-terminal element", async ({
    page,
  }) => {
    await page.goto("/session/test-terminal-escape");
    await page.waitForLoadState("networkidle");

    // Switch to Terminal tab.
    await page.getByRole("tab", { name: "Terminal" }).click();

    const container = page.getByTestId("terminal-container");
    await expect(container).toBeVisible({ timeout: 10_000 });

    // Find a focusable inside the terminal (ghostty's hidden textarea).
    const innerFocusable = container
      .locator('textarea, [tabindex="0"]')
      .first();
    await expect(innerFocusable).toHaveCount(1, { timeout: 10_000 });
    await innerFocusable.focus();

    // Sanity: focus is inside terminal.
    const focusInsideBefore = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-testid="terminal-container"]',
      );
      return root ? root.contains(document.activeElement) : false;
    });
    expect(focusInsideBefore).toBe(true);

    // Press Tab — focus should leave the terminal.
    await page.keyboard.press("Tab");

    const focusInsideAfter = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-testid="terminal-container"]',
      );
      return root ? root.contains(document.activeElement) : false;
    });
    expect(focusInsideAfter).toBe(false);
  });
});
