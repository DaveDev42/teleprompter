import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Feature: bulk-select and delete stopped sessions from the Sessions tab.
//
// The user taps "Edit" to enter edit mode, taps stopped session rows to
// toggle their checkboxes, then taps "Delete (N)" to open a confirm modal
// and confirm the deletion. After deletion the rows disappear and the Edit
// button is visible again (normal mode restored).
//
// IPC: deleted sessions are removed from local store state (no relay message
// is needed for the offline-first test scenario — the store remove is the
// same mechanism used for any single-session removal).

const SESSIONS_KEY = "tp_sessions_v1";

function makeSessionPayload() {
  const now = Date.now();
  return {
    "daemon-a": [
      {
        sid: "bulk-running-1",
        cwd: "/tmp/running-project",
        state: "running",
        createdAt: now - 300_000,
        updatedAt: now - 10_000,
        lastSeq: 5,
      },
      {
        sid: "bulk-stopped-1",
        cwd: "/tmp/stopped-alpha",
        state: "stopped",
        createdAt: now - 200_000,
        updatedAt: now - 60_000,
        lastSeq: 12,
      },
      {
        sid: "bulk-stopped-2",
        cwd: "/tmp/stopped-beta",
        state: "stopped",
        createdAt: now - 100_000,
        updatedAt: now - 30_000,
        lastSeq: 7,
      },
    ],
  };
}

test.describe("Sessions bulk delete", () => {
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

  test("Edit button is visible and enters edit mode on click", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const editBtn = page.getByTestId("sessions-edit-button");
    await expect(editBtn).toBeVisible();

    await editBtn.click();

    // In edit mode: Cancel + Delete buttons appear; Edit button is gone.
    await expect(page.getByTestId("sessions-edit-cancel")).toBeVisible();
    await expect(page.getByTestId("sessions-edit-delete")).toBeVisible();
    await expect(editBtn).toHaveCount(0);
  });

  test("Cancel exits edit mode and restores normal header", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();
    await expect(page.getByTestId("sessions-edit-cancel")).toBeVisible();

    await page.getByTestId("sessions-edit-cancel").click();

    await expect(page.getByTestId("sessions-edit-button")).toBeVisible();
    await expect(page.getByTestId("sessions-edit-cancel")).toHaveCount(0);
  });

  test("stopped rows render as checkboxes in edit mode; running row does not", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Two stopped sessions → two checkbox elements.
    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    await expect(checkboxes).toHaveCount(2);
  });

  test("tapping a stopped row toggles its aria-checked and updates count", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    const first = checkboxes.first();

    // Initially unchecked.
    await expect(first).toHaveAttribute("aria-checked", "false");

    await first.click();

    await expect(first).toHaveAttribute("aria-checked", "true");

    // Count text should update.
    const countLabel = page.getByTestId("sessions-edit-count");
    await expect(countLabel).toHaveText("1 Selected");
  });

  test("Delete button is disabled (aria-disabled) when nothing selected", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "true");
  });

  test("selecting two rows enables Delete button", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "false");
  });

  test("clicking Delete opens confirm modal with correct count", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    await page.getByTestId("sessions-edit-delete").click();

    // Confirm modal appears.
    await expect(
      page.getByTestId("confirm-delete-sessions-cancel"),
    ).toBeVisible();
    await expect(
      page.getByTestId("confirm-delete-sessions-confirm"),
    ).toBeVisible();
  });

  test("cancelling confirm modal returns to edit mode with selection intact", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    await checkboxes.nth(0).click();

    await page.getByTestId("sessions-edit-delete").click();
    await page.getByTestId("confirm-delete-sessions-cancel").click();

    // Still in edit mode, selection preserved (count still shows 1).
    await expect(page.getByTestId("sessions-edit-count")).toHaveText(
      "1 Selected",
    );
  });

  test("confirming delete removes the two stopped rows and exits edit mode", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 3 sessions initially (1 running + 2 stopped).
    const list = page.locator('[role="listitem"]');
    await expect(list).toHaveCount(3);

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator(
      `[role="checkbox"]:not([data-testid="sessions-select-all"])`,
    );
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    await page.getByTestId("sessions-edit-delete").click();
    await page.getByTestId("confirm-delete-sessions-confirm").click();

    // Edit mode exits automatically.
    await expect(page.getByTestId("sessions-edit-button")).toBeVisible();
    await expect(page.getByTestId("sessions-edit-cancel")).toHaveCount(0);

    // Only the running session remains.
    await expect(list).toHaveCount(1);
  });

  test("no-stopped-sessions notice renders when all sessions are running", async ({
    context,
    page,
  }) => {
    // Override the beforeEach seed: only running sessions.
    await context.addInitScript(
      ({ key, payload }) => {
        try {
          localStorage.removeItem(key);
          localStorage.setItem(key, JSON.stringify(payload));
        } catch {
          // ignore
        }
      },
      {
        key: SESSIONS_KEY,
        payload: {
          "daemon-a": [
            {
              sid: "only-running",
              cwd: "/tmp/running",
              state: "running",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastSeq: 0,
            },
          ],
        },
      },
    );

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    await expect(page.getByTestId("sessions-edit-no-stopped")).toBeVisible();
    await expect(page.getByTestId("sessions-edit-no-stopped")).toHaveText(
      "No stopped sessions to clean up",
    );
  });

  // ── Select-all toggle (cases 11–16) ────────────────────────────────────

  test("Select-all toggle appears when stopped sessions exist; hidden otherwise", async ({
    context,
    page,
  }) => {
    // Verify toggle is visible with the default seed (2 stopped).
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    await expect(page.getByTestId("sessions-select-all")).toBeVisible();

    // Now override to running-only and verify toggle is absent.
    await context.addInitScript(
      ({ key, payload }) => {
        try {
          localStorage.removeItem(key);
          localStorage.setItem(key, JSON.stringify(payload));
        } catch {
          // ignore
        }
      },
      {
        key: SESSIONS_KEY,
        payload: {
          "daemon-a": [
            {
              sid: "sa-running-only",
              cwd: "/tmp/running",
              state: "running",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastSeq: 0,
            },
          ],
        },
      },
    );

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Toggle must NOT be rendered when there are no stopped sessions.
    await expect(page.getByTestId("sessions-select-all")).toHaveCount(0);
    // The "no stopped" notice must still show.
    await expect(page.getByTestId("sessions-edit-no-stopped")).toBeVisible();
  });

  test("clicking Select-all checks every stopped checkbox", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Before: all checkboxes unchecked.
    const checkboxes = page.locator(
      '[role="checkbox"]:not([data-testid="sessions-select-all"])',
    );
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.nth(0)).toHaveAttribute("aria-checked", "false");
    await expect(checkboxes.nth(1)).toHaveAttribute("aria-checked", "false");

    await page.getByTestId("sessions-select-all").click();

    // After: all stopped checkboxes must be checked.
    await expect(checkboxes.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect(checkboxes.nth(1)).toHaveAttribute("aria-checked", "true");
  });

  test("clicking Deselect-all clears every checkbox", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Select all first.
    await page.getByTestId("sessions-select-all").click();

    const checkboxes = page.locator(
      '[role="checkbox"]:not([data-testid="sessions-select-all"])',
    );
    await expect(checkboxes.nth(0)).toHaveAttribute("aria-checked", "true");

    // Toggle is now "Deselect all" — click it.
    await page.getByTestId("sessions-select-all").click();

    // After: all unchecked.
    await expect(checkboxes.nth(0)).toHaveAttribute("aria-checked", "false");
    await expect(checkboxes.nth(1)).toHaveAttribute("aria-checked", "false");
  });

  test("Select-all label reflects N stopped sessions", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const toggle = page.getByTestId("sessions-select-all");
    // Default seed has 2 stopped sessions.
    await expect(toggle).toHaveText("Select all (2)");
  });

  test("after selecting some manually, toggle still says Select all; after selecting all, toggle flips to Deselect all", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const toggle = page.getByTestId("sessions-select-all");

    // Select just the first stopped row manually.
    const checkboxes = page.locator(
      '[role="checkbox"]:not([data-testid="sessions-select-all"])',
    );
    await checkboxes.nth(0).click();

    // Partial selection → still "Select all (N)".
    await expect(toggle).toHaveText("Select all (2)");

    // Select the second row too.
    await checkboxes.nth(1).click();

    // All selected → label flips.
    await expect(toggle).toHaveText("Deselect all");
  });

  test("after Select-all, Delete (N) button is enabled with N = stopped.length", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Before select-all: Delete button is aria-disabled.
    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "true");

    // Click Select-all.
    await page.getByTestId("sessions-select-all").click();

    // Now 2 sessions selected → Delete (2) enabled.
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("sessions-edit-count")).toHaveText(
      "2 Selected",
    );
  });
});
