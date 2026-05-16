import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: PR #360 added `role="main"` to the bottom-tab screens
// (Sessions, Daemons, Settings) but the two standalone pairing-flow
// routes (`/pairing`, `/pairing/scan`) were not updated in that pass.
// Screen-reader users opening a deep-link pairing URL had no landmark
// shortcut to reach the form body and had to Tab past every header —
// WCAG 2.4.1 Bypass Blocks (Level A) requires a mechanism to skip
// repeated content.
//
// Fix: add the same web-only `role="main"` spread on the root <View>
// of `pairing/index.tsx` (and its `state === "pairing"` early-return
// branch) and on the web fallback of `pairing/scan.tsx`.
test.describe("Pairing routes expose role=main landmark", () => {
  test("/pairing has exactly one role=main landmark", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const count = await page.locator('main, [role="main"]').count();
    expect(count).toBe(1);
  });

  test("/pairing/scan has exactly one role=main landmark", async ({ page }) => {
    await page.goto("/pairing/scan");
    await page.waitForLoadState("networkidle");
    const count = await page.locator('main, [role="main"]').count();
    expect(count).toBe(1);
  });
});
