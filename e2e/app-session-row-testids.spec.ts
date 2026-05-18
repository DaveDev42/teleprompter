import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: Session rows used to be addressable only by visible cwd
// label, which mirrors the Settings-row problem fixed in PR #469 — any
// label tweak (e.g. cwd truncation logic, "running"/"stopped" copy)
// silently invalidates every spec that locates rows by name. Each
// session row now carries `data-testid="session-row-<sid>"` so future
// selectors can pin to the sid (stable per session) rather than copy.

const SESSIONS_KEY = "tp_sessions_v1";

function makeSessionPayload() {
  const now = Date.now();
  return {
    "daemon-a": [
      {
        sid: "row-testid-running",
        cwd: "/tmp/testid-running",
        state: "running",
        createdAt: now - 60_000,
        updatedAt: now - 5_000,
        lastSeq: 3,
      },
      {
        sid: "row-testid-stopped",
        cwd: "/tmp/testid-stopped",
        state: "stopped",
        createdAt: now - 120_000,
        updatedAt: now - 30_000,
        lastSeq: 8,
      },
    ],
  };
}

test.describe("Session rows expose stable testIDs", () => {
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

  test("each session row has its data-testid attached", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByTestId("session-row-row-testid-running"),
    ).toBeVisible();
    await expect(
      page.getByTestId("session-row-row-testid-stopped"),
    ).toBeVisible();
  });

  test("testID survives edit mode (stopped row stays addressable)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // After entering edit mode the underlying Pressable for stopped rows
    // changes role to checkbox; the testID must travel with it so e2e
    // specs that select rows continue working regardless of edit state.
    await expect(
      page.getByTestId("session-row-row-testid-stopped"),
    ).toBeVisible();
    // Running row in edit mode becomes a plain View, but still tagged.
    await expect(
      page.getByTestId("session-row-row-testid-running"),
    ).toBeVisible();
  });
});
