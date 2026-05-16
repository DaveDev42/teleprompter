import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: WAI-ARIA 1.2 §6.3.26 (tab role) requires each
// `role="tab"` to be owned by a `role="tablist"`. React Navigation
// wraps each tab anchor in a sibling <div> on web, so the tabs are
// grandchildren of the tablist — the accessibility tree may not
// treat them as owned tabs without an explicit `aria-owns` bridge.
// (Keyboard nav + tabindex work fine; the gap is purely the owned-
// elements relationship that ATs use to report tab counts and
// active tab.)
//
// Fix: in `apps/app/app/(tabs)/_layout.tsx`'s tablist-init effect,
// give each tab a stable `id` and set the tablist's `aria-owns`
// to the space-joined id list. Session-view's Chat/Terminal
// tablist is unaffected — its tabs are already direct children.
test.describe("Bottom navigation tablist owns its tabs", () => {
  test("tablist has aria-owns listing all three tab ids", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionsTab = page.locator('[data-testid="tab-sessions"]').first();
    await expect(sessionsTab).toBeVisible();

    const ariaOwns = await sessionsTab.evaluate((el) => {
      const tablist = el.closest('[role="tablist"]');
      return tablist?.getAttribute("aria-owns") ?? null;
    });
    expect(ariaOwns).not.toBeNull();
    const ids = (ariaOwns ?? "").split(/\s+/).filter(Boolean);
    expect(ids).toContain("tab-sessions");
    expect(ids).toContain("tab-daemons");
    expect(ids).toContain("tab-settings");
  });

  test("aria-owns ids resolve to elements with role=tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionsTab = page.locator('[data-testid="tab-sessions"]').first();
    await expect(sessionsTab).toBeVisible();

    const allOwnedAreTabs = await sessionsTab.evaluate((el) => {
      const tablist = el.closest('[role="tablist"]');
      const ownsAttr = tablist?.getAttribute("aria-owns") ?? "";
      const ids = ownsAttr.split(/\s+/).filter(Boolean);
      if (ids.length === 0) return false;
      return ids.every((id) => {
        const node = document.getElementById(id);
        return node?.getAttribute("role") === "tab";
      });
    });
    expect(allOwnedAreTabs).toBe(true);
  });
});
