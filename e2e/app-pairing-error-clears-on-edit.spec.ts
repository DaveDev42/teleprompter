import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: after a failed Connect on /pairing, the Zustand `error` from
// processScan stayed set until the next submit. The inline "Doesn't look
// like pairing data" hint gates on `!error`, so the user editing the
// textarea saw the stale role=alert banner describing a payload they had
// already replaced — and the live hint that would tell them what was
// actually wrong with their new draft never appeared. Clearing the error
// as soon as the user types restores the intended single-source-of-truth:
// the banner reflects the most recent submitted attempt, the hint reflects
// the current draft.
test.describe("Pairing error clears when user edits input", () => {
  test("typing after a failed Connect dismisses the error banner", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByTestId("pairing-input");
    await textarea.fill("not-valid-pairing-data-at-all-12345");

    const connect = page.getByTestId("pairing-connect");
    await connect.click();

    const errorBanner = page.getByTestId("pairing-error");
    await expect(errorBanner).toBeVisible();

    // Simulate the user fixing their input — one keystroke is enough.
    await textarea.focus();
    await page.keyboard.press("End");
    await page.keyboard.type("x");

    await expect(errorBanner).toHaveCount(0);
  });
});
