import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: when the sessions search filter returns zero results, the
// Sessions screen rendered the same "No active sessions" headline used for
// the cold-start empty state, and no live region announced the change.
// Screen reader users (NVDA / JAWS / VoiceOver) heard nothing after typing
// their query and were left with a misleading message implying the store
// itself is empty.
//
// WCAG 4.1.3 Status Messages (Level AA): a change in the visible filter
// result count must be programmatically determinable without moving focus.
// The fix differentiates the empty-state copy when a filter is active and
// wraps that headline in `role="status"` + `aria-live="polite"` on web so
// AT politely announces the change.

const SESSIONS_KEY = "tp_sessions_v1";

test.describe("Sessions search empty-state announcement", () => {
  test.beforeEach(async ({ context }) => {
    // Seed >2 sessions so the search input renders (`sessions.length > 2`
    // gate in apps/app/app/(tabs)/index.tsx). Use a serializable shape
    // matching PersistedSessionMap.
    await context.addInitScript((key) => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("tp_")) localStorage.removeItem(k);
        }
        const payload = {
          "daemon-a": [
            {
              sid: "sid-aaa",
              cwd: "/tmp/aaa",
              state: "running",
              updatedAt: 1_700_000_000_000,
            },
            {
              sid: "sid-bbb",
              cwd: "/tmp/bbb",
              state: "stopped",
              updatedAt: 1_699_999_000_000,
            },
            {
              sid: "sid-ccc",
              cwd: "/tmp/ccc",
              state: "stopped",
              updatedAt: 1_699_998_000_000,
            },
          ],
        };
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // ignore
      }
    }, SESSIONS_KEY);
  });

  test("zero-match filter shows distinct headline announced via role=status", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // All three seeded sessions visible — search input is rendered.
    const search = page.getByTestId("session-search");
    await expect(search).toBeVisible();

    await search.fill("zzz-no-such-session");

    const headline = page.getByTestId("sessions-empty-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveText("No sessions match your search");
    await expect(headline).toHaveAttribute("role", "status");
    await expect(headline).toHaveAttribute("aria-live", "polite");

    // The CTA must NOT render in the filtered-empty branch — the user
    // already has sessions; routing them to the Daemons tab would be
    // misleading.
    await expect(
      page.getByRole("button", { name: "Go to Daemons" }),
    ).toHaveCount(0);
  });

  test("cold-start empty state keeps original copy and CTA (no role=status)", async ({
    context,
    page,
  }) => {
    // Override the beforeEach seed with an empty store so the cold-start
    // branch renders.
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("tp_")) localStorage.removeItem(k);
        }
      } catch {
        // ignore
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const headline = page.getByTestId("sessions-empty-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveText("No active sessions");
    // No role=status on cold-start headline — nothing changed for AT to
    // announce, and adding a polite region on mount would compete with
    // page-load announcements.
    await expect(headline).not.toHaveAttribute("role", "status");

    await expect(
      page.getByRole("button", { name: "Go to Daemons" }),
    ).toBeVisible();
  });
});
