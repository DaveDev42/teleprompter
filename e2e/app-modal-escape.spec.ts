import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// Regression: react-native-web's TextInput calls e.stopPropagation() on every
// keydown, which previously blocked the document-level Escape handler from
// closing modals while focus was inside a TextInput. The fix listens on the
// capture phase in `use-keyboard.ts`.
test.describe("Modal Escape key (focus inside TextInput)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-settings").waitFor({ timeout: 30_000 });
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Appearance").waitFor({ timeout: 5_000 });
  });

  test("Escape closes ApiKeyModal even when input is focused with text", async ({
    page,
  }) => {
    await page.evaluate(() => {
      (
        Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
          el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
        ) as HTMLElement | undefined
      )?.click();
    });

    const input = page.locator('[aria-label="OpenAI API key"]');
    await input.waitFor({ timeout: 5_000 });

    await input.focus();
    await input.type("sk-test");

    await page.keyboard.press("Escape");

    await expect(input).not.toBeVisible({ timeout: 3_000 });
  });
});
