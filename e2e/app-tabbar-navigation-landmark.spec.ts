import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the bottom tab bar lacked a `role="navigation"` landmark
// wrapper. ARIA 1.2 §5.3.10 + WCAG 2.4.1 Bypass Blocks (Level A) — a
// `role="tablist"` is a widget role, not a landmark, so AT users
// navigating by landmark ("D" in NVDA, "W" / rotor "Landmarks" in
// VoiceOver) couldn't jump to the bottom navigation at all. The only
// landmark on each screen was `role="main"`. Even though React Navigation
// renders the tablist with `aria-label="Main navigation"` (set
// imperatively — see `_layout.tsx`), without the navigation landmark
// the tablist is unreachable via landmark mode.
//
// Fix: in `_layout.tsx`'s sync effect, promote the tablist's parent
// <div> to `role="navigation"` with `aria-label="Main navigation"`.
test.describe("Bottom tab bar has role=navigation landmark", () => {
  test("navigation landmark is present on the Sessions tab", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionsTab = page.locator('[data-testid="tab-sessions"]').first();
    await expect(sessionsTab).toBeVisible();

    const nav = await sessionsTab.evaluate((el) => {
      const tablist = el.closest('[role="tablist"]');
      const wrapper = tablist?.parentElement ?? null;
      return {
        role: wrapper?.getAttribute("role") ?? null,
        label: wrapper?.getAttribute("aria-label") ?? null,
      };
    });
    expect(nav.role).toBe("navigation");
    expect(nav.label).toBe("Main navigation");
  });

  test("exactly one navigation landmark on each tab route", async ({
    page,
  }) => {
    for (const path of ["/", "/daemons", "/settings"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      // Either <nav> or `[role="navigation"]` counts — RN Web emits the
      // role attribute and may map it to <nav>.
      const count = await page.locator('nav, [role="navigation"]').count();
      expect(count, `route ${path}`).toBe(1);
    }
  });
});
