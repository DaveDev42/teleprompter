import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

async function openApiKeyModal(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (
      Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
        el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
      ) as HTMLElement | undefined
    )?.click();
  });
}

// Regression: ApiKeyModal Save button used `disabled={!canSave}` on the
// Pressable, which RN Web maps to native HTML `disabled`. The browser
// then skips disabled elements in Tab order, so a keyboard user landing
// on the API-key input had no way to discover that a Save button even
// exists — Tab from the input jumped past Save to Done or the modal
// overlay. Same pattern as the chat Send + pairing Connect fixes:
// drop native `disabled`, mirror aria-disabled via ref + useEffect,
// gate the onPress handler so the click still no-ops when invalid.
test.describe("ApiKey Save button keyboard reachability", () => {
  test("Tab from input reaches Save even when disabled (empty input)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await openApiKeyModal(page);
    const input = page.getByRole("textbox", { name: "OpenAI API key" });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.focus();

    await page.keyboard.press("Tab");
    const focusedLabel = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    );
    expect(focusedLabel).toBe("Save API key");

    const save = page.getByRole("button", { name: "Save API key" });
    await expect(save).toHaveAttribute("aria-disabled", "true");

    // Save is focusable AND announces disabled state. Typing flips it on.
    await input.fill("sk-anything");
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
  });
});
