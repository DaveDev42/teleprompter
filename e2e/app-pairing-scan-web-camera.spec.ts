import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// ---------------------------------------------------------------------------
// Helper: mock getUserMedia so tests are deterministic in a headless browser
// ---------------------------------------------------------------------------

/** Inject before page load to reject getUserMedia with NotAllowedError. */
async function mockGetUserMediaDenied(page: import("@playwright/test").Page) {
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
}

/**
 * Inject before page load so getUserMedia never settles. This keeps scanState
 * in the "requesting" phase indefinitely, which is ideal for asserting that
 * the camera viewfinder container is rendered while waiting for the user's
 * camera permission decision.
 */
async function mockGetUserMediaPending(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => new Promise(() => {}), // never resolves
      },
      writable: true,
      configurable: true,
    });
    // Ensure BarcodeDetector is absent (same as most non-Chromium browsers).
    delete (window as Record<string, unknown>).BarcodeDetector;
  });
}

// ---------------------------------------------------------------------------
// Camera viewfinder branch — getUserMedia pending (requesting state)
//
// The viewfinder container and CTAs are shown as soon as the component mounts
// while getUserMedia has not yet settled. We test with a never-resolving stub
// so scanState stays in "requesting" throughout, making the viewfinder stable
// to assert without racing against the real camera denial timing in CI.
// ---------------------------------------------------------------------------

test.describe("Pairing scan web — camera viewfinder (requesting)", () => {
  test("renders the viewfinder container", async ({ page }) => {
    await mockGetUserMediaPending(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("domcontentloaded");

    // The viewfinder wrapper is rendered as soon as the component mounts in
    // "requesting" state — before getUserMedia settles.
    const viewfinder = page.getByTestId("scan-web-viewfinder");
    await expect(viewfinder).toBeVisible({ timeout: 5_000 });
  });

  test("renders the manual-fallback CTA alongside the viewfinder", async ({
    page,
  }) => {
    await mockGetUserMediaPending(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("domcontentloaded");

    const cta = page.getByTestId("scan-web-manual-fallback");
    await expect(cta).toBeVisible({ timeout: 5_000 });
    // Must be a real button for keyboard / AT users.
    await expect(cta).toHaveRole("button");
    // Accessible name required by WCAG 4.1.2.
    await expect(cta).toHaveAccessibleName(/enter pairing code manually/i);
  });

  test("manual-fallback CTA is keyboard-reachable via Tab", async ({
    page,
  }) => {
    await mockGetUserMediaPending(page);
    await page.goto("/pairing/scan");

    // Wait for the viewfinder to appear before Tab-walking.
    await page.getByTestId("scan-web-viewfinder").waitFor({ timeout: 5_000 });

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
      if (/enter.*manually|enter code/i.test(label)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Denied branch — fallback message + manual-entry CTA
// ---------------------------------------------------------------------------

test.describe("Pairing scan web — camera denied", () => {
  test("shows the fallback message after permission denied", async ({
    page,
  }) => {
    await mockGetUserMediaDenied(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    const msg = page.getByTestId("scan-web-fallback-message");
    await expect(msg).toBeVisible({ timeout: 5_000 });
    await expect(msg).toContainText(/camera access was denied/i);
  });

  test("manual-fallback CTA is visible and has role=button", async ({
    page,
  }) => {
    await mockGetUserMediaDenied(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    const cta = page.getByTestId("scan-web-manual-fallback");
    await expect(cta).toBeVisible({ timeout: 5_000 });
    await expect(cta).toHaveRole("button");
    await expect(cta).toHaveAccessibleName(/enter pairing code manually/i);
  });

  test("Go Back button is visible and has role=button", async ({ page }) => {
    await mockGetUserMediaDenied(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    // The fallback UI always exposes Go Back so users can escape the screen.
    const back = page.getByTestId("scan-web-go-back");
    await expect(back).toBeVisible({ timeout: 5_000 });
    await expect(back).toHaveRole("button");
    await expect(back).toHaveAccessibleName(/go back/i);
  });

  test("manual-fallback CTA is keyboard-reachable via Tab", async ({
    page,
  }) => {
    await mockGetUserMediaDenied(page);
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");

    // Wait for the denied fallback UI.
    await page.getByTestId("scan-web-fallback-message").waitFor({
      timeout: 5_000,
    });

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
      if (/enter.*manually|enter pairing/i.test(label)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
