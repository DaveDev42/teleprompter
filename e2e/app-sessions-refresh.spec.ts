import { expect, test } from "@playwright/test";

/**
 * Sessions tab manual-refresh affordance.
 *
 * Regression guard for the "Sessions list does not refresh / no pull-to-refresh"
 * bug: before the fix the screen was 100% push-driven with NO way for the user
 * to force a refresh. The fix adds a header refresh button (and RefreshControl
 * on both the list and the empty-state ScrollView). This CI spec runs without a
 * daemon and verifies the discoverable affordance on web — the button exists,
 * is exposed as a button with an accessible name, and is keyboard-reachable.
 *
 * The end-to-end propagation behaviour (a session created after the app
 * connected shows up after a refresh) is covered by the daemon-backed
 * `local` project, since it needs a real relay round-trip.
 */
test.describe("App Web — Sessions refresh affordance", () => {
  test("header exposes a keyboard-reachable Refresh button", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    const refresh = page.getByTestId("sessions-refresh-button");
    await expect(refresh).toBeVisible();

    // Exposed as a button with an accessible name (not just a bare glyph).
    await expect(refresh).toHaveRole("button");
    await expect(refresh).toHaveAccessibleName("Refresh sessions");

    // Keyboard-reachable: focusing it and pressing Enter must not throw and the
    // button stays in the tab order (tabIndex !== -1).
    await refresh.focus();
    await expect(refresh).toBeFocused();
    const tabIndex = await refresh.getAttribute("tabindex");
    expect(tabIndex).not.toBe("-1");

    // Pressing it with no daemon connected is a no-op that must not crash the
    // screen — the Sessions heading is still there afterwards.
    await refresh.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Sessions", level: 1 }),
    ).toBeVisible();
  });
});
