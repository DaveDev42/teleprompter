import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `PermissionCard` in `apps/app/src/components/ChatCard.tsx`
// declared BOTH `accessibilityRole="alert"` and
// `accessibilityLiveRegion="assertive"`. RN Web translates these to
// `role="alert"` and `aria-live="assertive"` on the same element.
//
// Per ARIA 1.2 §6.2.1, an explicit `aria-live` value *overrides* the
// implicit live-region properties carried by `role="alert"` — which
// per ARIA 1.2 §6.3.3 are BOTH `aria-live="assertive"` AND
// `aria-atomic="true"`. So spelling out only `aria-live="assertive"`
// silently strips the implicit `aria-atomic=true`. NVDA/JAWS then
// announce only the changed text fragment when the card updates,
// instead of the full "Permission required: <text>, tool: <tool>"
// label. Users miss the context of *why* permission is needed.
//
// Fix: drop the explicit `accessibilityLiveRegion` from PermissionCard
// so role=alert's implicit assertive+atomic take effect together —
// matching sibling `SystemCard` and `ElicitationCard` (see
// app-chat-card-alert-no-polite.spec.ts).
//
// Structural invariant check (chat-store is in-memory and can't be
// seeded from Playwright): for any `role="alert"` that mounts anywhere
// in the app, the element must NOT carry an explicit `aria-live`
// attribute at all. Same defensive structure as
// app-chat-card-alert-no-polite.spec.ts but stricter — that spec only
// blocked `aria-live="polite"`; this spec blocks any explicit value
// because BOTH "polite" (downgrade) AND "assertive" (atomic strip)
// regressions matter.
test.describe("role=alert must not carry an explicit aria-live", () => {
  const routesToScan = [
    "/",
    "/daemons",
    "/settings",
    "/pairing",
    "/pairing/scan",
    "/session/test-alert-atomic-invariant",
  ];

  for (const route of routesToScan) {
    test(`role=alert has no explicit aria-live on ${route}`, async ({
      page,
    }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const offenders = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="alert"]'))
          .filter((el) => el.hasAttribute("aria-live"))
          .map((el) => ({
            ariaLive: el.getAttribute("aria-live"),
            label: el.getAttribute("aria-label"),
            tagName: el.tagName,
            outerHTMLPrefix: el.outerHTML.slice(0, 200),
          }));
      });

      expect(offenders).toEqual([]);
    });
  }
});
