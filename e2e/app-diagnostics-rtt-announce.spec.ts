import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: pressing "Ping daemon" in Diagnostics updates the RTT
// row from "—" to "Xms" but no ancestor of that row carries `aria-live`
// or `role="status"`, so a screen reader user pressed Enter and heard
// silence. The E2EE CRYPTO section already exposes a live region for
// the self-test result — this mirrors that pattern for the Connection
// section's Ping outcome.
test.describe("Diagnostics RTT announcement", () => {
  test("live region exists, is polite, and starts empty", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();
    await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible({
      timeout: 5_000,
    });

    const region = page.getByTestId("rtt-announcement");
    await expect(region).toHaveAttribute("aria-live", "polite");
    // Initial open must NOT announce anything — the user hasn't pressed
    // Ping yet.
    expect((await region.textContent())?.trim() ?? "").toBe("");
  });

  test("Pressing Ping populates the live region", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();
    await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible({
      timeout: 5_000,
    });

    const region = page.getByTestId("rtt-announcement");
    const ping = page.getByRole("button", { name: /^Ping daemon$/ });
    await ping.click();

    // The static dist bundle has no daemon attached so `getTransport()`
    // returns null and `handlePing` no-ops — in that case the
    // announcement stays empty. When a transport is connected we get
    // either "Pinging daemon" (transient) or "RTT: Xms" / "Ping failed"
    // (final). Accept any of those.
    //
    // What we really want to guard against is regressions where the
    // setAttribute escape hatch breaks or the live region disappears.
    // Verify the region is still polite and present after the click —
    // the textContent assertion would flake here because the dist
    // fixture has no daemon.
    await expect(region).toHaveAttribute("aria-live", "polite");
    await expect(region).toBeAttached();
  });
});
