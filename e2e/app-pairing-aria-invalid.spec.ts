import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the pairing screen's textarea handles two error sources
// asymmetrically. The async `error` branch (after a Connect failure)
// correctly sets `aria-invalid="true"`, but the inline `showInputHint`
// branch (typed value can't be decoded) only wired `aria-describedby`
// without `aria-invalid`. WCAG 4.1.2 (Name, Role, Value, Level A) +
// WAI-ARIA 1.2 §6.6.7 require the field's invalid state to be
// programmatically determinable; without `aria-invalid="true"` screen
// readers don't surface that the field itself is in an error state,
// even though they announce the hint text.
//
// Fix: add `"aria-invalid": true` to the `showInputHint` branch in
// `apps/app/app/pairing/index.tsx` so both error sources are
// announced consistently.
test.describe("Pairing input exposes aria-invalid during inline validation", () => {
  test("aria-invalid is set when the typed value is unparseable", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const input = page.getByTestId("pairing-input");
    await input.fill("not a pairing url");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute(
      "aria-describedby",
      "pairing-input-hint",
    );
  });

  test("aria-invalid is absent when the field is empty", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const input = page.getByTestId("pairing-input");
    expect(await input.getAttribute("aria-invalid")).toBeNull();
  });
});
