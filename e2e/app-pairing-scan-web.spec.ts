import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: on web, /pairing/scan used to render a "Go Back" Pressable with
// no accessibilityRole/Label and no tabIndex/focus class. Screen readers saw
// just a div, and keyboard users couldn't tell the focused element was
// actionable. Make sure the web scan screen exposes a real role=button +
// aria-label for Go Back and joins the web tab order with the shared focus
// class.
//
// With the new camera QR scan UI the Go Back button is present in both the
// camera viewfinder (alongside "Enter code manually") and the
// permission-denied / unsupported fallback panel. In a headless Playwright
// browser getUserMedia always rejects (no camera), so we reliably end up in
// the denied fallback panel — Go Back is always rendered there.
test.describe("Pairing scan web fallback accessibility", () => {
  // Stub getUserMedia to reject immediately so the denied fallback renders
  // deterministically in headless Chromium (no camera available in CI).
  test.beforeEach(async ({ page }) => {
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
  });

  test("Go Back exposes role=button and aria-label", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");
    // Wait for the camera denial to resolve and the fallback panel to appear.
    await page.getByTestId("scan-web-go-back").waitFor({ timeout: 5_000 });
    const button = page.getByRole("button", { name: /^Go back$/i });
    await expect(button).toBeVisible();
  });

  test("Go Back is keyboard-reachable via Tab", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("scan-web-go-back").waitFor({ timeout: 5_000 });

    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
    });

    let found = false;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("aria-label") || el?.innerText?.trim() || "";
      });
      if (/go back/i.test(label)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
