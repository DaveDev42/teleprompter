import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session-stopped banner used to be conditionally
// mounted (`{stopped && <View testID="session-stopped-banner" ...>}`).
// NVDA / JAWS attach a mutation observer when a live region enters the
// accessibility tree and then watch for text content changes on that
// already-present node. If the region is mounted together with its
// first content, the observer is attached at insertion time — too late
// to fire on the content it was inserted with — and the first
// announcement ("Session ended — read-only view") is silently dropped.
// ARIA Live Regions spec (WAI-ARIA 1.2 §6.6.3) and WCAG 4.1.3 (Status
// Messages) require status transitions to be programmatically
// observable.
//
// The fix wraps the banner in an always-mounted SessionStoppedLiveRegion
// component (mirrors ConnectionLiveRegion / InAppToast / VoiceButton
// state regions). This spec asserts the always-mounted invariant — the
// wrapper must be attached before the session ever flips to stopped,
// must be in the a11y tree (no `display: none` / `aria-hidden="true"`),
// and must carry aria-live="polite" + aria-atomic="true" so the full
// announcement reads as one chunk instead of just the diff.
test.describe("session-stopped-banner live region is always mounted", () => {
  test("banner wrapper attached and in a11y tree before any stop transition", async ({
    page,
  }) => {
    await page.goto("/session/test-stopped-banner-mount");
    // Session view needs to land — wait for the chat tab.
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const banner = page.getByTestId("session-stopped-banner");

    // Wrapper must be in the DOM right after the session view mounts,
    // before the session is ever stopped (or even before its metadata
    // arrives). Without this, AT never has a stable observer for the
    // "Session ended" transition.
    await expect(banner).toBeAttached();

    // RN Web translates accessibilityLiveRegion="polite" to
    // aria-live="polite" on the rendered <div>; role="status" is set on
    // web via the inline platform prop.
    await expect(banner).toHaveAttribute("aria-live", "polite");
    await expect(banner).toHaveAttribute("role", "status");

    // aria-atomic must be "true" so the full label ("Session ended.
    // Read-only view.") is read as one chunk rather than the diff.
    // ConnectionLiveRegion sets this imperatively via setAttribute
    // because RN Web 0.21 strips aria-atomic from the prop spread —
    // we mirror that here.
    await expect(banner).toHaveAttribute("aria-atomic", "true");

    // Pre-stop: no inner chrome (no warning dot, no text), but the
    // wrapper element itself stays present.
    await expect(page.getByTestId("session-stopped-banner-chrome")).toHaveCount(
      0,
    );

    // `display: none` or `aria-hidden="true"` on the wrapper would
    // remove it from the accessibility tree and re-create the original
    // bug. Assert neither is in effect.
    const display = await banner.evaluate(
      (el) => window.getComputedStyle(el).display,
    );
    expect(display).not.toBe("none");

    const ariaHidden = await banner.getAttribute("aria-hidden");
    expect(ariaHidden).not.toBe("true");
  });
});
