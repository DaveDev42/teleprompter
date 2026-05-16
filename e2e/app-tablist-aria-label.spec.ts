import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: WAI-ARIA APG §3.21 Tabs Pattern lists `aria-label` (or
// `aria-labelledby`) as a *required* property on the `role="tablist"`
// element so AT users hear the widget's purpose. The app has two
// tablists in play — the bottom tabbar (Sessions/Daemons/Settings)
// and the per-session view (Chat/Terminal). Both shipped without an
// accessible name, so a screen reader user heard a bare "tablist"
// with no context, and the two tablists were indistinguishable on
// pages where both are mounted.
//
// Fix: set `aria-label="Main navigation"` on the bottom tabbar
// imperatively (React Navigation's BottomTabBar exposes no prop for
// tablist-level ARIA), and `aria-label="Session view"` on the
// session-view tablist via the existing `tablistWebProps` bag.
test.describe("Tablist exposes accessible name", () => {
  test("Bottom navigation tablist has aria-label='Main navigation'", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionsTab = page.locator('[data-testid="tab-sessions"]').first();
    await expect(sessionsTab).toBeVisible();

    // The tablist container is the closest ancestor with role="tablist".
    const ariaLabel = await sessionsTab.evaluate((el) => {
      const tablist = el.closest('[role="tablist"]');
      return tablist?.getAttribute("aria-label") ?? null;
    });
    expect(ariaLabel).toBe("Main navigation");
  });

  test("Session view Chat/Terminal tablist has aria-label='Session view'", async ({
    page,
  }) => {
    await page.goto("/session/test-tablist-aria");
    await page.waitForLoadState("networkidle");

    const tablist = page
      .locator('[role="tablist"][aria-label="Session view"]')
      .first();
    await expect(tablist).toBeVisible({ timeout: 5_000 });
    await expect(tablist).toHaveAttribute("aria-label", "Session view");
  });

  test("Both tablists are distinguishable by accessible name on session view", async ({
    page,
  }) => {
    // Pages that render session view also still have the bottom tabbar
    // mounted (the session route is outside the (tabs) group, so this is
    // a defense-in-depth check — even if expo-router ever changes and
    // both tablists end up co-mounted, their accessible names must
    // disambiguate them).
    await page.goto("/session/test-tablist-aria-distinct");
    await page.waitForLoadState("networkidle");

    const named = page.locator('[role="tablist"][aria-label]');
    const count = await named.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Collect all aria-label values and ensure every tablist has one.
    const labels = await page
      .locator('[role="tablist"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("aria-label") ?? ""),
      );
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    // All accessible names must be unique so AT users can tell them
    // apart by name alone.
    expect(new Set(labels).size).toBe(labels.length);
  });
});
