import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: an earlier patch added `aria-haspopup="dialog"` to the
// "Add daemon" `+` button in the `/daemons` header on the theory that
// it opens the `pairing/index` "modal" screen (declared via
// `presentation: "modal"` in `app/_layout.tsx`). On NATIVE that
// presentation is a true modal dialog, but on WEB expo-router renders
// `pairing/index` as a regular route navigation to `/pairing` — the
// URL changes, the user lands on a full screen, and there is NO
// `role="dialog"` wrapper anywhere in the DOM. So advertising
// `aria-haspopup="dialog"` was a false promise to AT users.
//
// WAI-ARIA 1.2 §6.3.5 (aria-haspopup): "Indicates the availability and
// type of interactive popup element, such as menu or dialog, that can
// be triggered by an element." The popup type advertised must actually
// appear when the control is activated. WCAG 4.1.2 (Name, Role, Value,
// Level A) is satisfied only when the programmatic role/state matches
// observed behavior.
//
// Invariant: the Add daemon button must NOT carry aria-haspopup at
// all, and clicking it must navigate to `/pairing` without mounting a
// `role="dialog"` element.
test.describe("Add daemon button has no false aria-haspopup", () => {
  test("Add daemon button does not carry aria-haspopup", async ({ page }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const btn = page.getByRole("button", { name: "Add daemon" });
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveAttribute("aria-haspopup");
  });

  test("clicking Add daemon navigates to /pairing, no dialog mounts", async ({
    page,
  }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const btn = page.getByRole("button", { name: "Add daemon" });
    await btn.click();
    await page.waitForURL(/\/pairing(\/|$)/);
    await page.waitForLoadState("networkidle");

    const dialogCount = await page.evaluate(
      () => document.querySelectorAll('[role="dialog"]').length,
    );
    expect(dialogCount).toBe(0);
  });
});
