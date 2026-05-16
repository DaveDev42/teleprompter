import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// BUG-73: Bottom navigation tabs (role="tab") have no aria-controls attribute.
//
// WAI-ARIA 1.2 §6.3.26 (tab role) requires each `role="tab"` element to
// reference its associated `role="tabpanel"` via `aria-controls`. Without
// this relationship, assistive technology users cannot programmatically jump
// from an active tab to its content panel — the AT announces the tab widget
// but provides no path to the panel. (NVDA/JAWS both use the aria-controls
// relationship to enable the "move to panel" shortcut.)
//
// The bottom nav tablist already has aria-owns (app-tablist-aria-owns.spec.ts)
// and aria-orientation (app-tablist-aria-orientation.spec.ts), but individual
// tab→panel aria-controls is missing.
//
// Fix: in the TabsLayout useEffect in apps/app/app/(tabs)/_layout.tsx, after
// setting each tab's id, also add aria-controls="<panel-id>" and ensure the
// corresponding role="tabpanel" element has a matching id. The panel element
// is the `role="main"` wrapper rendered by expo-router's screen — either
// promote it to `role="tabpanel"` (requires adding aria-labelledby) or
// introduce a companion `role="tabpanel"` wrapper.
//
// WCAG reference: WCAG 4.1.2 Name, Role, Value (Level A) — UI components
// must expose name, role, and state/property to AT. The tab→panel
// aria-controls is the "property" that exposes the controlled region.
test.describe("Bottom navigation tab aria-controls", () => {
  test("each bottom-nav tab exposes aria-controls pointing to a panel", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tabIds = ["tab-sessions", "tab-daemons", "tab-settings"];

    for (const testId of tabIds) {
      const tab = page.locator(`[data-testid="${testId}"]`).first();
      await expect(tab).toBeVisible();

      // Each tab must declare the panel it controls
      const ariaControls = await tab.getAttribute("aria-controls");
      expect(ariaControls, `${testId} is missing aria-controls`).not.toBeNull();

      // The referenced element must exist in the DOM
      if (ariaControls) {
        const panel = page.locator(`#${ariaControls}`).first();
        await expect(
          panel,
          `aria-controls="${ariaControls}" on ${testId} does not resolve to a DOM element`,
        ).toBeAttached();
      }
    }
  });

  test("active tab's aria-controls panel has role=tabpanel", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const activeTab = page.locator('[data-testid="tab-sessions"]').first();
    const ariaControls = await activeTab.getAttribute("aria-controls");
    expect(ariaControls, "Active tab missing aria-controls").not.toBeNull();

    if (ariaControls) {
      const panel = page.locator(`#${ariaControls}`).first();
      await expect(panel).toHaveAttribute("role", "tabpanel");
    }
  });
});
