import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Diagnostics row in /settings is a WAI-ARIA APG
// Disclosure trigger — it already carries `aria-expanded` (PR #367),
// but `aria-controls` was missing. The Disclosure Pattern §3.9 requires
// the trigger to point at the `id` of the controlled region so screen
// readers can announce "Diagnostics, button, collapsed, controls
// diagnostics panel" and AT users can jump from the trigger to the
// panel programmatically. Without it, the relationship is invisible to
// the a11y tree even though the visual mapping is obvious.
//
// Fix: SettingsRow accepts an optional `controlsId` prop. The
// Diagnostics row passes `controlsId="settings-diagnostics-panel"` and
// the panel's outer View carries the matching `id` on web. ARIA allows
// `aria-controls` to point at an element that becomes present only when
// expanded (common disclosure pattern), so the spec opens the panel
// before asserting the id resolves to a real element.
test.describe("Diagnostics disclosure aria-controls", () => {
  test("Diagnostics trigger has aria-controls and panel carries the matching id", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.locator('[aria-label="Diagnostics"]');
    await expect(trigger).toBeVisible({ timeout: 5_000 });

    const controls = await trigger.getAttribute("aria-controls");
    expect(controls).toBe("settings-diagnostics-panel");

    // Open the panel — the controlled region renders inline via the
    // showDiagnostics early-return branch and carries the matching id.
    await trigger.click();

    const panel = page.locator("#settings-diagnostics-panel");
    await expect(panel).toBeVisible({ timeout: 5_000 });
  });
});
