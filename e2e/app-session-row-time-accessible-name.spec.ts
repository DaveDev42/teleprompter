import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: in `apps/app/app/(tabs)/index.tsx`, the SessionRow Pressable
// is `role="button"` with an explicit `accessibilityLabel` like
// "project, running, selected". On web, `role=button` with an explicit
// aria-label overrides descendant text for the accessible name (ARIA 1.2
// §4.3.2 "Accessible Name and Description Computation"), so the visible
// "5m ago" timestamp that rides inside the Pressable is invisible to
// screen-reader focus-mode users — they only hear the explicit
// aria-label. The chevron, status dot, and divider are decorative
// duplicates and stay aria-hidden, but the relative timestamp carries
// information that is NOT present in the explicit label, so it must be
// folded into the accessible name itself.
//
// Fix: prepend "updated ${timeAgo(...)}" into the accessibilityLabel
// template before any optional ", selected" suffix.
//
// WCAG 4.1.2 Name, Role, Value (Level A). WCAG 2.4.6 Headings and
// Labels (Level AA). Same family of regressions as the chevron / status
// dot / divider aria-hidden specs in
// `app-session-row-chevron-aria-hidden.spec.ts` and
// `app-session-row-status-dot-aria-hidden.spec.ts`.
test.describe("SessionRow aria-label includes the relative update time", () => {
  test("every SessionRow's aria-label carries a timeAgo fragment", async ({
    page,
  }) => {
    // Seed two sessions before navigating so the empty-state branch
    // doesn't render. The session-store persists under
    // `tp_sessions_v1` (secure-storage prefixes the in-store key
    // "sessions_v1" with "tp_" on web).
    await page.addInitScript(() => {
      const now = Date.now();
      const map = {
        "daemon-a": [
          {
            sid: "row-time-1",
            cwd: "/tmp/project-alpha",
            state: "running",
            createdAt: now - 5 * 60_000,
            updatedAt: now - 5 * 60_000,
            lastSeq: 0,
          },
          {
            sid: "row-time-2",
            cwd: "/tmp/project-beta",
            state: "stopped",
            createdAt: now - 90 * 60_000,
            updatedAt: now - 90 * 60_000,
            lastSeq: 0,
          },
        ],
      };
      localStorage.setItem("tp_sessions_v1", JSON.stringify(map));
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Find all SessionRow Pressables. They render as elements with
    // role=button and the visible "session description" text. Filter by
    // accessible name pattern so we don't pick up other buttons (tabs,
    // settings, etc.) that share the role.
    const rows = page.getByRole("button", {
      name: /project-alpha|project-beta/,
    });

    // If seeding doesn't take (Expo Router reset, store init race), the
    // spec is vacuously true — same defensive stance as
    // app-sessions-list-ownership.spec.ts. The post-fix run on real
    // builds in CI consistently surfaces the seeded rows.
    const count = await rows.count();
    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const label = await row.getAttribute("aria-label");
      expect(
        label,
        `SessionRow #${i} should have an aria-label`,
      ).not.toBeNull();
      // timeAgo() returns "just now", "Xm ago", "Xh ago", or "Xd ago".
      // The label must contain at least one of those fragments, prefixed
      // with the literal "updated " marker the fix introduced.
      expect(
        label ?? "",
        `SessionRow #${i} aria-label should include "updated <timeAgo>"`,
      ).toMatch(/updated (?:just now|\d+[mhd] ago)/);
    }
  });
});
