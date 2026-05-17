import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: InAppToast used to return null when no toast was active, so
// the live region was inserted into the DOM only after the first
// notification. NVDA/JAWS don't reliably announce updates for regions
// that didn't exist at page load (ARIA19 / APG live-region pattern
// requires the container to be present upfront). The fix keeps the
// role=status wrapper mounted at all times and hides it with
// display:none + pointerEvents=none while empty.
test.describe("InAppToast live region", () => {
  test("role=status container is mounted before any toast fires", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Select by testID to avoid matching other role=status live regions
    // (e.g. the sessions edit live region added in PR #432).
    const liveRegion = page.getByTestId("toast-live-region");
    await expect(liveRegion).toHaveCount(1);
    await expect(liveRegion).toHaveAttribute("aria-live", "polite");
    // role=status has implicit aria-atomic=true per ARIA 1.2, but several
    // SR/version combos ignore the implicit default and read only the
    // diff when text changes. The container must carry the attribute
    // explicitly so updates are announced atomically.
    await expect(liveRegion).toHaveAttribute("aria-atomic", "true");
  });
});
