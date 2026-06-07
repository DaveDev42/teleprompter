import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: in normal mode the session row's accessible name folds in the
// relative update time ("updated 5m ago") because the visible timestamp Text
// is suppressed from the accessible name by the explicit aria-label (ARIA 1.2
// §4.3.2). Edit mode's checkbox row carries its own explicit aria-label too,
// but it used to OMIT the timestamp — so screen-reader users heard the update
// time in normal mode and lost it the moment they entered edit mode (a WCAG
// 4.1.2 parity gap). The checkbox aria-label must now also carry the time.

const SESSIONS_KEY = "tp_sessions_v1";

function makeSessionPayload() {
  const now = Date.now();
  return {
    "daemon-a": [
      {
        sid: "edit-time-stopped",
        cwd: "/tmp/edit-time-stopped",
        state: "stopped",
        createdAt: now - 7_200_000,
        // ~2 hours ago → timeAgo() renders "2h ago"
        updatedAt: now - 7_200_000,
        lastSeq: 8,
      },
    ],
  };
}

test.describe("Session row edit-mode accessible name", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      ({ key, payload }) => {
        try {
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith("tp_")) localStorage.removeItem(k);
          }
          localStorage.setItem(key, JSON.stringify(payload));
        } catch {
          // ignore
        }
      },
      { key: SESSIONS_KEY, payload: makeSessionPayload() },
    );
  });

  test("edit-mode checkbox aria-label includes the relative update time", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Normal mode: the row already exposes the update time in its name.
    const normalRow = page.getByTestId("session-row-edit-time-stopped");
    const normalLabel = await normalRow.getAttribute("aria-label");
    expect(normalLabel).toContain("updated");

    // Enter edit mode — the stopped row becomes a role=checkbox.
    await page.getByTestId("sessions-edit-button").click();

    const checkboxLabel = await page
      .getByTestId("session-row-edit-time-stopped")
      .getAttribute("aria-label");

    // The checkbox label must convey state...
    expect(checkboxLabel?.toLowerCase()).toContain("stopped");
    // ...AND the update time, matching normal-mode parity (WCAG 4.1.2).
    expect(checkboxLabel).toContain("updated");
  });
});
