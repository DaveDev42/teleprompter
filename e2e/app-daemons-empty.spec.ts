import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: on web, the Daemons empty state's primary CTA used to be
// "Scan QR Code to Pair", which routed to /pairing/scan — a screen that
// only renders "QR scanning is not available on web". Web users had no
// usable primary action. The empty state should now route to the manual
// pairing-data entry screen on web.
test.describe("Daemons empty state (web)", () => {
  test.beforeEach(async ({ context }) => {
    // Strip any cached pairings so the empty state actually renders.
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

  test("primary CTA on web does not lead to QR-scan dead-end", async ({
    page,
  }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    // The QR-scan CTA must not be the primary action on web.
    const scanCta = page.getByLabel("Scan QR code to pair");
    await expect(scanCta).toHaveCount(0);

    // The primary action should be the manual-entry button.
    const enterCta = page.getByLabel("Enter pairing data");
    await expect(enterCta).toBeVisible();

    await enterCta.click();
    await page.waitForLoadState("networkidle");
    // We should be on /pairing (manual entry), not /pairing/scan (dead-end).
    expect(page.url()).toContain("/pairing");
    expect(page.url()).not.toContain("/pairing/scan");

    // And the dead-end text must not appear.
    const dead = page.getByText("QR scanning is not available on web");
    await expect(dead).toHaveCount(0);
  });
});
