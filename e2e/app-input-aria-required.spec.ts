import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the pairing textarea and the OpenAI API Key modal input
// are both programmatically mandatory — the Connect / Save button is
// disabled until a value is entered — but neither input exposed
// `aria-required`. A screen reader user heard only the label
// ("Pairing data, text area") with no indication that a value was
// required; they had to Tab to the disabled submit and parse its
// aria-disabled state to infer the constraint.
//
// WCAG 2.1 SC 1.3.1 (Info and Relationships) and SC 4.1.2 (Name, Role,
// Value) both require the "required" property to be exposed
// programmatically. RN doesn't bridge `accessibilityRequired`, so the
// fix spreads `aria-required="true"` raw on web via the established
// Platform.OS gated bag pattern.
test.describe("Required inputs expose aria-required", () => {
  test("Pairing textarea has aria-required='true'", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("pairing-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("aria-required", "true");
  });

  test("API Key modal input has aria-required='true'", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the API Key modal via its Settings row.
    await page.locator('[aria-label^="OpenAI API Key"]').first().click();

    const input = page.locator('[aria-label="OpenAI API key"]');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveAttribute("aria-required", "true");
  });
});
