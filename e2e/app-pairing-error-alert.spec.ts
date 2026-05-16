import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the /pairing error banner declared role="alert" AND an
// explicit accessibilityLiveRegion="polite". role="alert" already implies
// aria-live="assertive" + aria-atomic="true" per ARIA 1.2 §6.3.3, and the
// author-supplied attribute wins (§6.2.1) — so NVDA/JAWS/VoiceOver received
// the banner as a polite region and queued the announcement behind whatever
// speech was in flight. A blocking pairing validation error must interrupt.
// InAppToast and UpdateBanner already corrected this anti-pattern; this
// spec guards the matching fix on the pairing screen.
test.describe("Pairing error banner role=alert", () => {
  test("pairing-error has role=alert without a downgrading aria-live", async ({
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
    await expect(errorBanner).toHaveAttribute("role", "alert");
    // role=alert carries implicit aria-live=assertive; an explicit
    // aria-live attribute on the same element would override the implicit
    // value and downgrade announcement priority.
    const ariaLive = await errorBanner.getAttribute("aria-live");
    expect(ariaLive).toBeNull();
  });
});
