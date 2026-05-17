import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: after a failed Connect on the pairing screen, the pairing
// store's `error` field stays populated until the next `processScan`
// call, but the input's `aria-invalid="true"` spread was gated on
// `error` alone. So even after the user cleared the textarea (no
// content to be invalid about) the field continued to announce as
// invalid and AT followed the stale `aria-errormessage` pointer to the
// previous error banner. WCAG 4.1.2 (Name Role Value, Level A) — the
// invalid state must reflect the field's CURRENT content, not a
// historical async failure.
//
// Fix: gate the async-error aria-invalid branch on
// `manualInput.trim().length > 0 && !preview` so an empty field (or a
// field the user has now corrected to a parseable URL) is no longer
// announced as invalid. The error banner stays visible for context;
// only the input's invalid attribute is removed.

test.describe("Pairing aria-invalid recovery after failed Connect", () => {
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

  test("aria-invalid clears when textarea is emptied after failed Connect", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByTestId("pairing-input");
    await expect(textarea).toBeVisible();

    // Type unparseable data and submit. processScan will throw at
    // decodePairingData → store sets `error` to "Failed to process QR
    // code" (or similar), state returns to "unpaired".
    await textarea.fill("not-valid-pairing-data-12345");

    const connect = page.getByRole("button", { name: /^Connect$/ });
    await expect(connect).toBeEnabled();
    await connect.click();

    // Wait for the error banner to appear. This is the moment when the
    // pre-fix code stamps aria-invalid="true" on the textarea.
    const errorBanner = page.locator('[nativeID="pairing-error"]').first();
    // Some builds emit it as an id instead of nativeID — fall back.
    const error = (await errorBanner.count())
      ? errorBanner
      : page.locator("#pairing-error");
    await expect(error).toBeVisible({ timeout: 5000 });

    // Sanity check: aria-invalid is present while the bad text is still
    // in the field.
    await expect(textarea).toHaveAttribute("aria-invalid", "true");

    // Now clear the textarea — simulate the user wiping the bad input.
    await textarea.fill("");

    // The error banner can still be visible (user hasn't acknowledged
    // it), but the empty field must no longer be announced as invalid.
    await expect(textarea).not.toHaveAttribute("aria-invalid", "true");
    // Defensive: aria-errormessage / aria-describedby pointing at the
    // stale error region must also be gone.
    await expect(textarea).not.toHaveAttribute(
      "aria-errormessage",
      "pairing-error",
    );
    await expect(textarea).not.toHaveAttribute(
      "aria-describedby",
      "pairing-error",
    );
  });
});
