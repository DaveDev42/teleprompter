import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session "Disconnected — messages will send after
// reconnect" / "Reconnected" live region was declared with role="status"
// but RN Web 0.21 strips `aria-atomic` from prop-level spread on <View>,
// so it never reached the DOM. role=status implies aria-atomic=true per
// ARIA 1.2, but NVDA/JAWS in some shipped versions ignore the implicit
// value and read only the text diff between updates — the user hears
// "Reconnected" stripped of surrounding context. InAppToast already
// solves the same problem with an imperative setAttribute; this spec
// guards the matching escape hatch on the session connection banner.
test.describe("Session connection live region aria-atomic", () => {
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

  test("session-connection-live-region carries aria-atomic=true on web", async ({
    page,
  }) => {
    await page.goto("/session/test-aria-atomic");
    await page.waitForLoadState("networkidle");

    const region = page.getByTestId("session-connection-live-region");
    await expect(region).toBeAttached({ timeout: 5_000 });
    await expect(region).toHaveAttribute("aria-atomic", "true");
    // Sanity: role and aria-live are still correct after the setAttribute
    // effect runs.
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveAttribute("aria-live", "polite");
  });
});
