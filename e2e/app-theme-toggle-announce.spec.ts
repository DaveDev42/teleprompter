import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: clicking the Theme row in Settings cycles its visible
// label (System → Dark → Light → ...) but focus stays on the same row
// button. RN Web/React Navigation doesn't re-announce aria-label on
// the focused element when it changes, so a screen reader user
// pressing Enter on Theme heard nothing — they had to Shift+Tab off
// and back to learn which theme they just landed on. Mirror the
// freshly-cycled label into an SR-only polite live region so AT
// speaks the new theme as the user cycles.
test.describe("Theme toggle announcement", () => {
  test("theme live region exists and starts empty", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const region = page.getByTestId("theme-announcement");
    await expect(region).toHaveAttribute("aria-live", "polite");
    // Initial mount must NOT announce — the user didn't ask for an
    // initial reading of the system theme.
    expect((await region.textContent())?.trim() ?? "").toBe("");
  });

  test("clicking Theme updates the live region with the new label", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const themeRow = page.getByText("Theme", { exact: true }).first();
    await themeRow.click();

    const region = page.getByTestId("theme-announcement");
    // After the first click the label cycles to whichever theme is
    // next in the System → Dark → Light loop. Whatever it lands on, it
    // must be one of the three and must appear inside the region.
    await expect(region).toHaveText(/^Theme: (System|Dark|Light)$/);
  });
});
