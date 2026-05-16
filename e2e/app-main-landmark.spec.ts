import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: WCAG 2.4.1 Bypass Blocks (Level A) requires a way for AT
// users to jump past repeated navigation blocks. Browsers expose
// `role="main"` (or a <main> element) as a landmark target in screen
// reader landmark-navigation modes (NVDA/JAWS/VoiceOver "g" key, etc.).
// Without a main landmark, an AT user on the Sessions/Daemons/Settings
// tab has to step through the entire bottom tablist on every screen
// just to reach the page body.
//
// The fix adds a web-only `role="main"` to each tab screen's root
// container. RN's `AccessibilityRole` union doesn't include "main", so
// the `role` prop is spread inside a `Platform.OS === "web"` gate to
// avoid affecting native AT semantics (Pressable et al. read
// `accessibilityRole`, not `role`).
test.describe("Tab screens expose role=main landmark", () => {
  for (const { path, name } of [
    { path: "/", name: "Sessions" },
    { path: "/daemons", name: "Daemons" },
    { path: "/settings", name: "Settings" },
  ]) {
    test(`${name} tab has exactly one role=main landmark`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      // Counting both <main> and `[role="main"]` covers either future
      // implementation choice — the spec is about the landmark, not the
      // element name. Today RN Web renders <main role="main"> from the
      // `role` prop; the assertion is forward-compatible if we ever
      // swap to a different element via createElement override.
      const count = await page.locator('main, [role="main"]').count();
      expect(count).toBe(1);
    });
  }
});
