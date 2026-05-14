import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the inline "Doesn't look like pairing data" hint was a plain
// <Text> with no live region. Sighted users saw it as they typed, but a
// screen reader user got nothing — they only learned the input was invalid
// after pressing Connect and hitting the after-the-fact error toast. Wrap
// the hint in role=status + aria-live=polite so the SR announces the
// validation feedback as it appears.
test.describe("Pairing input hint live region", () => {
  test("hint container exposes role=status with polite live region", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.fill("not a pairing url");

    const hint = page.getByTestId("pairing-input-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute("role", "status");
    // RN's accessibilityLiveRegion maps to aria-live on web. Polite is the
    // right intensity — the user is still typing, this is informational.
    await expect(hint).toHaveAttribute("aria-live", "polite");
  });
});
