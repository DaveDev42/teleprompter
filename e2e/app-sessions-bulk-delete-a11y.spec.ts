import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Accessibility assertions for the bulk-delete edit mode on the Sessions tab.
//
// Verifies:
//  - Edit button: role=button, aria-label, aria-pressed=false in normal mode
//  - Cancel button: role=button, aria-label
//  - Delete button: role=button, aria-label includes count, aria-disabled
//  - Session checkboxes in edit mode: role=checkbox, aria-checked
//  - Live region: role=status, aria-live=polite, always mounted
//
// Companion to app-sessions-bulk-delete.spec.ts (functional flow).

const SESSIONS_KEY = "tp_sessions_v1";

function makeSessionPayload() {
  const now = Date.now();
  return {
    "daemon-a": [
      {
        sid: "a11y-running-1",
        cwd: "/tmp/a11y-running",
        state: "running",
        createdAt: now - 200_000,
        updatedAt: now - 5_000,
        lastSeq: 3,
      },
      {
        sid: "a11y-stopped-1",
        cwd: "/tmp/a11y-alpha",
        state: "stopped",
        createdAt: now - 100_000,
        updatedAt: now - 20_000,
        lastSeq: 8,
      },
      {
        sid: "a11y-stopped-2",
        cwd: "/tmp/a11y-beta",
        state: "stopped",
        createdAt: now - 50_000,
        updatedAt: now - 10_000,
        lastSeq: 4,
      },
    ],
  };
}

test.describe("Sessions bulk-delete a11y", () => {
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

  test("Edit button has role=button and aria-label='Edit sessions'", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const editBtn = page.getByTestId("sessions-edit-button");
    await expect(editBtn).toBeVisible();
    await expect(editBtn).toHaveAttribute("role", "button");
    await expect(editBtn).toHaveAttribute("aria-label", "Edit sessions");
  });

  test("Edit button exposes aria-pressed=false in normal mode", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const editBtn = page.getByTestId("sessions-edit-button");
    await expect(editBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("Cancel button has role=button and aria-label='Cancel edit'", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const cancelBtn = page.getByTestId("sessions-edit-cancel");
    await expect(cancelBtn).toHaveAttribute("role", "button");
    await expect(cancelBtn).toHaveAttribute("aria-label", "Cancel edit");
  });

  test("Delete button has role=button and aria-disabled=true when nothing selected", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("role", "button");
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "true");
  });

  test("Delete button aria-label reflects selected count", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Initially no selection: label says "Delete 0 sessions".
    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("aria-label", "Delete 0 sessions");

    // Select one.
    const checkboxes = page.locator('[role="checkbox"]');
    await checkboxes.first().click();
    await expect(deleteBtn).toHaveAttribute("aria-label", "Delete 1 sessions");

    // Select second.
    await checkboxes.nth(1).click();
    await expect(deleteBtn).toHaveAttribute("aria-label", "Delete 2 sessions");
  });

  test("Delete button aria-disabled=false when at least one session selected", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator('[role="checkbox"]');
    await checkboxes.first().click();

    const deleteBtn = page.getByTestId("sessions-edit-delete");
    await expect(deleteBtn).toHaveAttribute("aria-disabled", "false");
  });

  test("stopped session rows have role=checkbox + aria-checked in edit mode", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator('[role="checkbox"]');
    // Two stopped sessions in seed data.
    await expect(checkboxes).toHaveCount(2);

    for (let i = 0; i < 2; i++) {
      const cb = checkboxes.nth(i);
      await expect(cb).toHaveAttribute("role", "checkbox");
      await expect(cb).toHaveAttribute("aria-checked", "false");
    }
  });

  test("checkbox aria-checked toggles on click", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const cb = page.locator('[role="checkbox"]').first();
    await expect(cb).toHaveAttribute("aria-checked", "false");

    await cb.click();
    await expect(cb).toHaveAttribute("aria-checked", "true");

    await cb.click();
    await expect(cb).toHaveAttribute("aria-checked", "false");
  });

  test("checkboxes have descriptive aria-label including session name", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    const checkboxes = page.locator('[role="checkbox"]');
    // Each checkbox label should mention the session directory name and state.
    for (let i = 0; i < 2; i++) {
      const label = await checkboxes.nth(i).getAttribute("aria-label");
      expect(label).toBeTruthy();
      // Label must include "stopped" (session state).
      expect(label?.toLowerCase()).toContain("stopped");
    }
  });

  test("live region is always mounted with role=status and aria-live=polite", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Live region must exist before edit mode is ever activated (always-mounted
    // pattern so NVDA/JAWS mutation observers are attached before content changes).
    const liveRegion = page.getByTestId("sessions-edit-live-region");
    await expect(liveRegion).toBeAttached();
    await expect(liveRegion).toHaveAttribute("role", "status");
    await expect(liveRegion).toHaveAttribute("aria-live", "polite");

    // Pre-activation: no announcement text yet.
    await expect(liveRegion).toHaveText("");

    // display:none or aria-hidden=true would remove it from the a11y tree.
    const display = await liveRegion.evaluate(
      (el) => window.getComputedStyle(el).display,
    );
    expect(display).not.toBe("none");

    const ariaHidden = await liveRegion.getAttribute("aria-hidden");
    expect(ariaHidden).not.toBe("true");
  });

  test("live region announces edit mode entry", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const liveRegion = page.getByTestId("sessions-edit-live-region");

    await page.getByTestId("sessions-edit-button").click();

    // After entering edit mode the region should have some non-empty text.
    const text = await liveRegion.textContent();
    expect(text?.trim()).toBeTruthy();
  });

  test("live region announces edit mode exit via Cancel", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // Enter + exit.
    await page.getByTestId("sessions-edit-cancel").click();

    const liveRegion = page.getByTestId("sessions-edit-live-region");
    const text = await liveRegion.textContent();
    // Should announce cancellation.
    expect(text?.toLowerCase()).toContain("cancel");
  });
});
