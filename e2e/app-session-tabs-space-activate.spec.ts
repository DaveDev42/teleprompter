import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: APG Tabs §3.23 + WCAG 2.1.1 require that pressing Space or
// Enter while a role=tab element has focus activates that tab. The session
// view's Chat/Terminal tabs render as <div role="tab"> (RN Web Pressable
// emits a <div>, not a native <button>), so the browser's "Space clicks
// the focused button" shortcut doesn't apply. Enter works incidentally
// because Pressable's synthetic onClick catches it, but Space falls
// through with no effect — keyboard-only and SR users could not activate
// a tab from scratch (they could only cycle with Arrow/Home/End, which
// works because that handler covered them). Guard the Space path.
test.describe("Session view tab Space activation", () => {
  test("Space on a focused tab activates it (APG Tabs §3.23)", async ({
    page,
  }) => {
    await page.goto("/session/test-tab-space-activate");
    await page.waitForLoadState("networkidle");

    // Chat is the initial selection. Move focus to Terminal directly so
    // Space has a meaningful target to switch to (avoids confusion with
    // already-active tab no-op).
    await page.locator("#session-tab-terminal").focus();
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await page.keyboard.press(" ");

    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  test("Enter on a focused tab activates it (APG Tabs §3.23)", async ({
    page,
  }) => {
    await page.goto("/session/test-tab-enter-activate");
    await page.waitForLoadState("networkidle");

    await page.locator("#session-tab-terminal").focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
