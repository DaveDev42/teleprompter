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

test.describe("ApiKeyModal correctness", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("tp_")) localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    });
  });

  // Regression: useEffect only watched currentKey, so closing the modal
  // with an unsaved draft and reopening preserved the stale text. Fix
  // adds visible to the dep array and resets on each open.
  test("unsaved draft is discarded when reopening", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await openApiKeyModal(page);
    const input = page.getByRole("textbox", { name: "OpenAI API key" });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("sk-partial-should-be-discarded");
    await expect(input).toHaveValue("sk-partial-should-be-discarded");

    // Close via Escape — Done button is also valid but Escape exercises
    // the ModalContainer path that callers might use accidentally.
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 5_000 });

    await openApiKeyModal(page);
    const reopened = page.getByRole("textbox", { name: "OpenAI API key" });
    await expect(reopened).toBeVisible({ timeout: 5_000 });
    await expect(reopened).toHaveValue("");
  });

  // Regression: Save button silently no-op'd on empty input but didn't
  // expose its disabled state, so screen readers and visual users got no
  // feedback that the action was unavailable.
  test("Save button reflects disabled state when input is empty", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await openApiKeyModal(page);
    const save = page.getByRole("button", { name: "Save API key" });
    await expect(save).toBeVisible({ timeout: 5_000 });
    await expect(save).toHaveAttribute("aria-disabled", "true");

    // Typing enables Save.
    const input = page.getByRole("textbox", { name: "OpenAI API key" });
    await input.fill("sk-test-value");
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
  });
});
