import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the bottom TabBar set tabBarAccessibilityLabel to
// "<Name> tab" — but React Navigation already gives the button
// role="tab", so a screen reader announced "Sessions tab, tab"
// (label + role). Dropping the " tab" suffix from the label
// removes the duplication; the role-derived announcement is still
// in place.
test.describe("Bottom TabBar aria-label", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("Sessions tab label has no trailing 'tab' suffix", async ({ page }) => {
    const sessions = page.getByTestId("tab-sessions");
    await sessions.waitFor({ timeout: 10_000 });

    const label = await sessions.getAttribute("aria-label");
    expect(label).toBe("Sessions");
    // Role still propagates from React Navigation — assistive tech
    // announces the role on top of the bare name.
    expect(await sessions.getAttribute("role")).toBe("tab");
  });

  test("Daemons tab label has no trailing 'tab' suffix", async ({ page }) => {
    const daemons = page.getByTestId("tab-daemons");
    await daemons.waitFor({ timeout: 10_000 });
    expect(await daemons.getAttribute("aria-label")).toBe("Daemons");
    expect(await daemons.getAttribute("role")).toBe("tab");
  });

  test("Settings tab label has no trailing 'tab' suffix", async ({ page }) => {
    const settings = page.getByTestId("tab-settings");
    await settings.waitFor({ timeout: 10_000 });
    expect(await settings.getAttribute("aria-label")).toBe("Settings");
    expect(await settings.getAttribute("role")).toBe("tab");
  });
});
