import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `SystemCard` (StopFailure) and `ElicitationCard` in
// ChatCard.tsx declared `accessibilityRole="alert"` *together* with
// `accessibilityLiveRegion="polite"`. RN Web translates these to
// `role="alert"` and `aria-live="polite"` on the same element. Per
// ARIA 1.2 §6.2.1, an explicit `aria-live` value overrides the
// implicit `aria-live="assertive"` that `role="alert"` would carry
// (ARIA 1.2 §6.3.3) — so the failure / elicitation announcement gets
// silently downgraded to a polite queue behind in-flight speech and
// a screen reader user can miss it entirely.
//
// Fix: drop the explicit `accessibilityLiveRegion` from both cards so
// role=alert's implicit assertive takes effect. `PermissionCard` already
// uses `assertive` (correct).
//
// Structural invariant check (chat-store is in-memory and can't be
// seeded from Playwright): for any role=alert that mounts anywhere in
// the app, `aria-live` must NOT be "polite". This guards against the
// regression being reintroduced anywhere — same approach as the
// pairing-error-alert spec.
test.describe("Alerts must not be downgraded to aria-live=polite", () => {
  const routesToScan = [
    "/",
    "/daemons",
    "/settings",
    "/pairing",
    "/pairing/scan",
    "/session/test-alert-polite-invariant",
  ];

  for (const route of routesToScan) {
    test(`role=alert without aria-live=polite on ${route}`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const conflicting = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="alert"]')).filter(
          (el) => el.getAttribute("aria-live") === "polite",
        ).length;
      });

      expect(conflicting).toBe(0);
    });
  }
});
