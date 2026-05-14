import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontPickerModal items set accessibilityState.selected, but RN
// Web does not translate that to aria-selected. Screen readers couldn't tell
// which font was currently active. The fix passes aria-selected directly on
// web. Validate by opening the modal and asserting the option matching the
// current chat font has aria-selected="true" and all others "false".
test.describe("Font picker accessibility", () => {
  test("current font option has aria-selected=true", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the Chat Font picker by tapping the row.
    const chatFontRow = page.getByText("Chat Font", { exact: true }).first();
    await expect(chatFontRow).toBeVisible();
    await chatFontRow.click();

    // Modal renders a list of font options as role=button with aria-label
    // matching the font name. Inter is the default chat font.
    const inter = page.getByRole("button", { name: /^Inter$/ });
    await expect(inter).toBeVisible();
    await expect(inter).toHaveAttribute("aria-selected", "true");

    // A non-current option must report aria-selected="false" so screen
    // readers announce the selection state for every option (not "no info").
    const helvetica = page.getByRole("button", { name: /^Helvetica Neue$/ });
    await expect(helvetica).toHaveAttribute("aria-selected", "false");
  });
});
