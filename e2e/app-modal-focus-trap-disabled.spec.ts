import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ModalContainer's focus trap computed first/last from the raw
// querySelectorAll result, but the browser skips disabled controls during
// Tab. If the trailing focusable in DOM order was disabled (e.g. the
// ApiKeyModal Save button when the input is empty), the trap never saw
// focus reach `last`, so Tab escaped the modal entirely. The fix filters
// disabled controls before picking first/last so the trap matches the
// browser's actual focus order.
test.describe("Modal focus trap survives disabled tail", () => {
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

  test("Tab inside ApiKeyModal with disabled Save stays in modal", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the modal — Save is disabled because the key is empty.
    await page.evaluate(() => {
      (
        Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
          el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
        ) as HTMLElement | undefined
      )?.click();
    });

    const input = page.getByRole("textbox", { name: "OpenAI API key" });
    await expect(input).toBeVisible({ timeout: 5_000 });
    const save = page.getByRole("button", { name: "Save API key" });
    await expect(save).toHaveAttribute("aria-disabled", "true");

    // Place focus on the input, then Tab forward several times. Focus must
    // never land on <body> — that's the trap escape we're guarding against.
    await input.focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const tagName = await page.evaluate(
        () => document.activeElement?.tagName ?? null,
      );
      // Body indicates the trap was bypassed — fail loudly.
      expect(tagName).not.toBe("BODY");
    }
  });
});
