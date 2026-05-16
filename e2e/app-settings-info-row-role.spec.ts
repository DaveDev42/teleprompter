import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: Settings "Version" and "Updates" (when OTA status is
// `unavailable`, i.e. Dev build) render as a Pressable with no onPress.
// RN Web emits that as a bare <div> with no role. ARIA ignores
// `aria-label` on a generic <div>, so screen readers either concatenate
// the raw child text ("Version0.1.19") or read the children as
// unrelated nodes — the composed label "Version, 0.1.19" is silently
// dropped. Fix: assign role="group" on web for info-only rows so the
// composed aria-label is honored.
test.describe("Settings info-only row ARIA role", () => {
  test("Version row exposes role=group with composed aria-label", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Appearance").waitFor({ timeout: 10_000 });

    // Match the version number loosely — release-please bumps it on
    // every patch release. We only care that it's a numeric semver
    // suffix, not the specific value.
    const versionRow = page.locator('[role="group"][aria-label^="Version, "]');
    await expect(versionRow).toBeAttached({ timeout: 5_000 });
    const label = await versionRow.getAttribute("aria-label");
    expect(label).toMatch(/^Version, \S+/);
  });

  test("Updates (Dev build) row exposes role=group with composed aria-label", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Appearance").waitFor({ timeout: 10_000 });

    // OTA status is `unavailable` ("Dev build") under the static dist
    // bundle — same fixture pattern as app-settings-updates-aria.spec.ts.
    const row = page.locator('[role="group"][aria-label="Updates, Dev build"]');
    await expect(row).toBeAttached({ timeout: 5_000 });
  });
});
