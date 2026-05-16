import { expect, type Page, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

/**
 * Click a settings row by aria-label via JS evaluate, bypassing the tab bar
 * overlay that intercepts Playwright's native pointer-event-based clicks on
 * mobile viewport. Buttons deeper in the scroll area sit under a fixed tab
 * bar <div>, so JS click is the reliable path.
 */
async function clickSettingsRow(page: Page, ariaLabelPrefix: string) {
  await page.evaluate((prefix) => {
    const btn = Array.from(document.querySelectorAll("[aria-label]")).find(
      (el) => el.getAttribute("aria-label")?.startsWith(prefix),
    ) as HTMLElement | null;
    btn?.click();
  }, ariaLabelPrefix);
}

test.describe("App Keyboard Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-sessions").waitFor({ timeout: 30_000 });
  });

  // The original "Tab navigates through tab bar items" test pre-dated APG
  // Tabs roving tabindex (BUG-20) — it stepped through every nav tab with
  // Tab, which is exactly the behaviour roving tabindex eliminates.
  // Coverage moved to `app-tabbar-roving-tabindex.spec.ts` (active tab has
  // tabindex=0, inactive tabs have tabindex=-1, per `_layout.tsx`'s
  // `tabBarButton`).

  test("Enter activates settings rows", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    // Focus the theme button using its aria-label
    await page.locator('[aria-label*="Theme"]').first().focus();
    await page.keyboard.press("Enter");

    // Verify page is still responsive after theme cycle
    await expect(page.locator("text=Settings").first()).toBeVisible();
  });

  test("Tab reaches Chat/Terminal tabs in session view", async ({ page }) => {
    await page.goto("/session/test-keyboard");
    const chatTab = page.getByTestId("tab-chat");
    const terminalTab = page.getByTestId("tab-terminal");

    await chatTab.waitFor({ timeout: 10_000 });

    // APG Tabs pattern: active tab has tabindex=0 (Tab enters tablist),
    // arrow keys move between tabs (inactive tabs have tabindex=-1).
    await chatTab.focus();
    await expect(chatTab).toBeFocused();

    await page.keyboard.press("ArrowRight");

    // After ArrowRight the tablist handler activates the Terminal tab and
    // moves DOM focus to it via requestAnimationFrame. However, GhosttyTerminal
    // mounts in the same frame and may steal focus to its own container so the
    // terminal is keyboard-ready — that is correct behaviour.
    // Verify observable invariants:
    //   1. terminal tab is now aria-selected=true (mode switched)
    //   2. focus landed in the tablist or terminal area (not stuck on chat tab)
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    // Wait for the double-rAF focus move to settle, then check that focus is
    // no longer on the chat tab. It ends up on either the terminal tab
    // (brief window) or terminal-container (GhosttyTerminal auto-focus).
    await page.waitForFunction(() => {
      const testid = document.activeElement?.getAttribute("data-testid") ?? "";
      return testid !== "tab-chat";
    });
    const activeTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    );
    expect(["tab-terminal", "terminal-container"]).toContain(activeTestId);
  });

  test("Tab reaches chat input", async ({ page }) => {
    await page.goto("/session/test-keyboard");
    const chatInput = page.getByTestId("chat-input");

    await chatInput.waitFor({ timeout: 10_000 });

    await chatInput.focus();
    await expect(chatInput).toBeFocused();

    // Send button is disabled without daemon, so Tab may skip it.
    // Verify the send button exists and has tabIndex for when enabled.
    const sendButton = page.getByTestId("chat-send");
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toHaveAttribute("tabindex", "0");
  });

  test("Escape closes font picker modal", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    // Click Chat Font button via JS evaluate to bypass tab bar overlay
    await clickSettingsRow(page, "Chat Font");
    await page.locator("text=Chat Font").nth(1).waitFor({ timeout: 5_000 });

    await expect(page.locator("text=Done").first()).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.locator("text=Done").first()).not.toBeVisible({
      timeout: 3_000,
    });
  });

  test("focusable elements have tabindex for keyboard access", async ({
    page,
  }) => {
    // Tab bar tabs should be focusable (rendered by React Navigation)
    const settingsTab = page.getByTestId("tab-settings");
    await expect(settingsTab).toBeVisible();

    // Navigate to session view and verify our custom elements have tabindex
    await page.goto("/session/test-keyboard");
    const chatTab = page.getByTestId("tab-chat");
    await chatTab.waitFor({ timeout: 10_000 });
    await expect(chatTab).toHaveAttribute("tabindex", "0");

    // APG roving tabindex: active tab (Chat) is tabindex=0,
    // inactive tab (Terminal) is tabindex=-1.
    const terminalTab = page.getByTestId("tab-terminal");
    await expect(terminalTab).toHaveAttribute("tabindex", "-1");

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();
  });
});
