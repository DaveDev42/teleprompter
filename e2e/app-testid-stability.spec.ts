import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: a few primary action buttons lacked stable testID anchors, so
// QA/E2E flows resorted to brittle text/aria-label matchers. These IDs are
// the contract for cross-platform automation — adding them prevents flow
// breakage if labels are translated or copy is tweaked.
test.describe("Stable testID anchors", () => {
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

  test("Pairing Connect button exposes testID=pairing-connect", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const connect = page.getByTestId("pairing-connect");
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute("aria-label", "Connect");
  });
});
