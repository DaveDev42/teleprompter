import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RN Web's TextInput defaults autocomplete to "on" for both
// plain text and secureTextEntry (type=password) inputs. That means
// (a) the OS password manager tries to save the OpenAI API key like a
// credential and (b) one-time pairing tokens linger in the browser's
// textarea history dropdown. Both are sensitive values that should never
// be cached by the browser — set autoComplete="off" explicitly.
test.describe("Sensitive input autocomplete=off", () => {
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

  test("API key input has autocomplete=off", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the API Key modal — click the row labeled "OpenAI API Key".
    await page.evaluate(() => {
      (
        Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
          el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
        ) as HTMLElement | undefined
      )?.click();
    });

    // The label "OpenAI API key" is also on the trigger button and modal
    // wrapper — scope to the textbox role so we hit the actual input.
    const input = page.getByRole("textbox", { name: "OpenAI API key" });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveAttribute("autocomplete", "off");
  });

  test("Pairing data input has autocomplete=off", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("pairing-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("autocomplete", "off");
  });
});
