import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: handleSend bailed out silently when getTransport() returned
// null (no paired daemon), leaving the typed message stranded in the
// input and giving the user no signal that nothing was sent. Fix clears
// the input and surfaces a toast.
test.describe("Chat send when unpaired", () => {
  test("clears input and shows toast when no daemon is paired", async ({
    page,
  }) => {
    await page.goto("/session/test-unpaired-send");
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });
    await input.fill("hello daemon");
    await page.keyboard.press("Enter");

    await expect(input).toHaveValue("", { timeout: 5_000 });
    const toast = page.getByRole("alert").filter({ hasText: "Not paired" });
    await expect(toast).toBeVisible({ timeout: 5_000 });
  });
});
