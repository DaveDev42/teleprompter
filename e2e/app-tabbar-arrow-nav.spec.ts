import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the bottom navigation tabbar (Sessions / Daemons /
// Settings) implemented APG Tabs "roving tabindex" — only the active
// tab carries tabindex=0, inactive tabs are tabindex=-1 so Tab exits
// the tablist into content. But the matching half of the pattern was
// missing: per WAI-ARIA APG Tabs §3.21, ArrowRight/ArrowLeft must
// cycle focus among tabs (with wrap), Home/End jump to first/last.
// Without those keys the inactive tabindex=-1 tabs were completely
// unreachable by keyboard — a user landing on Sessions could never
// navigate to Daemons or Settings via keyboard at all. WCAG 2.1
// SC 2.1.1 Level A failure.
test.describe("Bottom tabbar APG arrow-key navigation", () => {
  test("ArrowRight cycles focus Sessions → Daemons → Settings → Sessions", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await expect(tabSessions).toHaveAttribute("aria-selected", "true");
    await tabSessions.focus();

    await page.keyboard.press("ArrowRight");
    // The newly-activated tab must (a) own the roving tab stop and
    // (b) actually have DOM focus. Roving tabindex without Arrow keys
    // is the broken state we're guarding against — assert both halves.
    await expect(tabDaemons).toHaveAttribute("aria-selected", "true");
    await expect(tabDaemons).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(tabSettings).toHaveAttribute("aria-selected", "true");
    await expect(tabSettings).toBeFocused();

    // Wrap: Settings → Sessions.
    await page.keyboard.press("ArrowRight");
    await expect(tabSessions).toHaveAttribute("aria-selected", "true");
    await expect(tabSessions).toBeFocused();
  });

  test("ArrowLeft cycles focus Sessions → Settings → Daemons", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await tabSessions.focus();

    // Wrap the other direction: Sessions → Settings (last tab).
    await page.keyboard.press("ArrowLeft");
    await expect(tabSettings).toHaveAttribute("aria-selected", "true");
    await expect(tabSettings).toBeFocused();

    await page.keyboard.press("ArrowLeft");
    await expect(tabDaemons).toHaveAttribute("aria-selected", "true");
    await expect(tabDaemons).toBeFocused();
  });

  test("Home jumps to Sessions, End jumps to Settings", async ({ page }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const tabSessions = page.getByTestId("tab-sessions");
    const tabDaemons = page.getByTestId("tab-daemons");
    const tabSettings = page.getByTestId("tab-settings");

    await tabDaemons.focus();

    await page.keyboard.press("End");
    await expect(tabSettings).toHaveAttribute("aria-selected", "true");
    await expect(tabSettings).toBeFocused();

    await page.keyboard.press("Home");
    await expect(tabSessions).toHaveAttribute("aria-selected", "true");
    await expect(tabSessions).toBeFocused();
  });
});
