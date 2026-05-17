import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the pairing textarea sets aria-invalid="true" + aria-describedby
// pointing at the error region, but lacked aria-errormessage. WAI-ARIA 1.2
// §6.6.5 specifies aria-errormessage as the standards-track pointer from an
// invalid field to its error message — JAWS 18+/NVDA prefix the announcement
// with "Error:" only when aria-errormessage resolves to an element. Without
// it, screen readers announce the hint text but lose the explicit error
// classification, leaving aria-invalid orphaned. WCAG 3.3.1 (Error
// Identification, Level A) is satisfied by the visible text but the
// machine-readable wiring is incomplete.
//
// Fix: add `"aria-errormessage"` alongside `"aria-describedby"` on both
// error branches (async `error` + inline `showInputHint`) in
// `apps/app/app/pairing/index.tsx`.
test.describe("Pairing input exposes aria-errormessage when invalid", () => {
  test("inline hint branch wires aria-errormessage to the hint id", async ({
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
    await expect(input).toHaveAttribute(
      "aria-errormessage",
      "pairing-input-hint",
    );

    // The referenced element must exist so AT can resolve it.
    const hint = page.locator("#pairing-input-hint");
    await expect(hint).toBeAttached();
  });

  test("async error branch wires aria-errormessage to the error id", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("pairing-input");
    await input.fill("not-valid-pairing-data-at-all-12345");

    const connect = page.getByTestId("pairing-connect");
    await connect.click();

    const errorBanner = page.getByTestId("pairing-error");
    await expect(errorBanner).toBeVisible();

    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-describedby", "pairing-error");
    await expect(input).toHaveAttribute("aria-errormessage", "pairing-error");

    // The referenced error region must exist on the page.
    const errorRegion = page.locator("#pairing-error");
    await expect(errorRegion).toBeAttached();
  });

  test("empty field has no aria-errormessage", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("pairing-input");
    expect(await input.getAttribute("aria-errormessage")).toBeNull();
  });
});
