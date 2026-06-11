import { expect, type Page, test } from "@playwright/test";

/**
 * Global single-key shortcuts (web): `?` opens the cheat-sheet, 1/2/3 jump
 * between bottom tabs, c/t switch the session screen's Chat/Terminal tabs.
 * Guards under test: shortcuts must NOT fire while typing in an editable
 * control or while a modal is open (modal-open-registry suppression).
 */

/**
 * Click a settings row by aria-label via JS evaluate. Mirrors
 * app-keyboard-nav.spec.ts — pointer-event clicks on rows under the fixed
 * tab bar are flaky, JS click is the reliable path.
 */
async function clickSettingsRow(page: Page, ariaLabelPrefix: string) {
  await page.evaluate((prefix) => {
    const btn = Array.from(document.querySelectorAll("[aria-label]")).find(
      (el) => el.getAttribute("aria-label")?.startsWith(prefix),
    ) as HTMLElement | null;
    btn?.click();
  }, ariaLabelPrefix);
}

test.describe("Global Keyboard Shortcuts", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-sessions").waitFor({ timeout: 30_000 });
  });

  test("? opens the shortcut help dialog and Escape closes it", async ({
    page,
  }) => {
    await page.keyboard.press("?");

    const modal = page.getByTestId("shortcut-help-modal");
    await expect(modal).toBeVisible();
    await expect(page.locator("text=Keyboard Shortcuts").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });

  test("digit keys navigate between bottom tabs", async ({ page }) => {
    await page.keyboard.press("2");
    await expect(page).toHaveURL(/\/daemons$/);

    await page.keyboard.press("3");
    await expect(page).toHaveURL(/\/settings$/);

    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/$/);
  });

  test("shortcuts do not fire while typing in a text input", async ({
    page,
  }) => {
    await page.goto("/pairing");
    const input = page.getByTestId("pairing-input");
    await input.waitFor({ timeout: 10_000 });

    await input.focus();
    await page.keyboard.type("?123");

    // Every keystroke landed in the textarea — none was swallowed by a
    // shortcut, no navigation happened, no help dialog opened.
    await expect(input).toHaveValue("?123");
    await expect(page).toHaveURL(/\/pairing$/);
    await expect(page.getByTestId("shortcut-help-modal")).not.toBeVisible();
  });

  test("c/t switch Chat/Terminal tabs on the session screen", async ({
    page,
  }) => {
    await page.goto("/session/test-shortcuts");
    const chatTab = page.getByTestId("tab-chat");
    const terminalTab = page.getByTestId("tab-terminal");
    await chatTab.waitFor({ timeout: 10_000 });

    await expect(chatTab).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("t");
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");

    // GhosttyTerminal does not steal focus on mount, so a follow-up `c`
    // (body focus, outside the data-shortcuts-disabled subtree) works.
    await page.keyboard.press("c");
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(terminalTab).toHaveAttribute("aria-selected", "false");
  });

  test("shortcuts are suppressed while a modal is open", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Settings").first().waitFor();

    await clickSettingsRow(page, "Chat Font");
    await expect(page.locator("text=Done").first()).toBeVisible({
      timeout: 5_000,
    });

    // `1` must NOT navigate away while the font picker is open.
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator("text=Done").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("text=Done").first()).not.toBeVisible({
      timeout: 3_000,
    });

    // After the modal closes, the registry releases and shortcuts resume.
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/$/);
  });

  test("help dialog itself suppresses navigation shortcuts", async ({
    page,
  }) => {
    await page.keyboard.press("?");
    await expect(page.getByTestId("shortcut-help-modal")).toBeVisible();

    await page.keyboard.press("2");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("shortcut-help-modal")).toBeVisible();

    await page.keyboard.press("Escape");
  });
});
