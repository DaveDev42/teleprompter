import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the disconnected banner was rendered only when !connected,
// so the live region itself unmounted on reconnect — a screen reader heard
// "Disconnected..." but nothing on recovery. Users were left uncertain
// whether their pending messages went out. The fix keeps a persistent
// live region attached to the DOM and toggles its inner chrome between
// "Disconnected...", a transient "Reconnected", and nothing.
test.describe("Session connection live region", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("tp_")) localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    });
  });

  test("live region wrapper stays mounted with role=status + aria-live=polite", async ({
    page,
  }) => {
    await page.goto("/session/test-reconnect-live-region");
    await page.waitForLoadState("networkidle");

    // The wrapper exists regardless of current state, so AT keeps a stable
    // anchor for both the disconnect and recovery announcements.
    const region = page.getByTestId("session-connection-live-region");
    await expect(region).toBeAttached();
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveAttribute("aria-live", "polite");
  });

  test("disconnected banner is rendered inside the live region with the right copy", async ({
    page,
  }) => {
    await page.goto("/session/test-reconnect-live-region-disc");
    await page.waitForLoadState("networkidle");

    const region = page.getByTestId("session-connection-live-region");
    await expect(region).toBeAttached();
    // No pairings → useAnyRelayConnected() is false → banner mounts.
    const banner = page.getByTestId("session-disconnected-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/disconnect/i);

    // Banner is a child of the live region so AT announcements are
    // routed through the persistent role=status wrapper.
    const isDescendant = await page.evaluate(() => {
      const reg = document.querySelector(
        '[data-testid="session-connection-live-region"]',
      );
      const banner = document.querySelector(
        '[data-testid="session-disconnected-banner"]',
      );
      return !!reg && !!banner && reg.contains(banner);
    });
    expect(isDescendant).toBe(true);
  });
});
