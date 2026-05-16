import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the bottom navigation tab bar (Sessions / Daemons /
// Settings) is rendered by Expo Router's <Tabs>, which uses React
// Navigation's default BottomTabBar button — it sets tabindex=0 on every
// tab regardless of which is currently selected. APG Tabs requires
// "roving tabindex": only the active tab is in the document tab
// sequence (tabindex=0), the inactive ones carry tabindex=-1 so Tab
// exits the tablist into content. Without roving tabindex every
// keyboard user has to Tab past three tabs on every page load, and SR
// users lose the Tab vs Arrow distinction that signals tablist widget
// semantics. The fix is a custom `tabBarButton` that wraps
// PlatformPressable and overrides tabIndex from aria-selected.
test.describe("Bottom tab bar roving tabindex", () => {
  test("Sessions active: Daemons and Settings are tabindex=-1", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await expect(tabSessions).toHaveAttribute("aria-selected", "true");
    await expect(tabSessions).toHaveAttribute("tabindex", "0");
    await expect(tabDaemons).toHaveAttribute("aria-selected", "false");
    await expect(tabDaemons).toHaveAttribute("tabindex", "-1");
    await expect(tabSettings).toHaveAttribute("aria-selected", "false");
    await expect(tabSettings).toHaveAttribute("tabindex", "-1");
  });

  test("Daemons active: Sessions and Settings are tabindex=-1", async ({
    page,
  }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await expect(tabDaemons).toHaveAttribute("aria-selected", "true");
    await expect(tabDaemons).toHaveAttribute("tabindex", "0");
    await expect(tabSessions).toHaveAttribute("tabindex", "-1");
    await expect(tabSettings).toHaveAttribute("tabindex", "-1");
  });

  test("Settings active: Sessions and Daemons are tabindex=-1", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await expect(tabSettings).toHaveAttribute("aria-selected", "true");
    await expect(tabSettings).toHaveAttribute("tabindex", "0");
    await expect(tabSessions).toHaveAttribute("tabindex", "-1");
    await expect(tabDaemons).toHaveAttribute("tabindex", "-1");
  });
});
