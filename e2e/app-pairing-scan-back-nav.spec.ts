import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: /pairing/scan web fallback used `router.back()` unconditionally.
// When a user lands here via deep link (or refreshes the page), there's no
// history entry, so the "Go Back" button is a no-op and strands the user on
// a dead-end screen. Guard with router.canGoBack() and fall back to the
// sessions tab.
//
// With the new camera QR scan UI the Go Back button is present in both the
// camera viewfinder and the permission-denied fallback panel. We stub
// getUserMedia to reject immediately so the test is deterministic in headless
// Chromium (no camera available in CI) and the fallback panel renders quickly.
test.describe("Pairing scan back nav (no history)", () => {
  test("Go Back navigates to sessions tab when there is no history", async ({
    page,
  }) => {
    // Stub getUserMedia to reject so the denied fallback renders immediately.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        value: {
          getUserMedia: () =>
            Promise.reject(
              Object.assign(new Error("Permission denied"), {
                name: "NotAllowedError",
              }),
            ),
        },
        writable: true,
        configurable: true,
      });
    });
    await page.goto("/pairing/scan");
    const back = page.getByRole("button", { name: /^Go back$/i });
    await back.waitFor({ timeout: 10_000 });
    await back.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
    await page.getByTestId("tab-sessions").waitFor({ timeout: 5_000 });
  });
});
