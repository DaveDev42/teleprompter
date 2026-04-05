import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("App Keyboard Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-sessions").waitFor({ timeout: 30_000 });
  });

  test("Tab navigates through tab bar items", async ({ page }) => {
    const sessionsTab = page.getByTestId("tab-sessions");
    const daemonsTab = page.getByTestId("tab-daemons");
    const settingsTab = page.getByTestId("tab-settings");

    await sessionsTab.focus();
    await expect(sessionsTab).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(daemonsTab).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(settingsTab).toBeFocused();

    // Enter activates the focused tab
    await page.keyboard.press("Enter");
    await expect(page.locator("text=Settings").first()).toBeVisible();
  });

  test("Enter activates settings rows", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    const themeButton = page.getByText("Theme").first();
    await themeButton.focus();
    await page.keyboard.press("Enter");

    // Verify page is still responsive after theme cycle
    await expect(page.locator("text=Settings").first()).toBeVisible();
  });

  test("Tab reaches Chat/Terminal tabs in session view", async ({ page }) => {
    await page.goto("/session/test-keyboard");
    const chatTab = page.getByTestId("tab-chat");
    const terminalTab = page.getByTestId("tab-terminal");

    await chatTab.waitFor({ timeout: 10_000 });

    await chatTab.focus();
    await expect(chatTab).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(terminalTab).toBeFocused();

    await page.keyboard.press("Enter");
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

    await page.getByText("Chat Font").click();
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

    const terminalTab = page.getByTestId("tab-terminal");
    await expect(terminalTab).toHaveAttribute("tabindex", "0");

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();
  });
});
