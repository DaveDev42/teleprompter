import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the VoiceButton stateLabel + transcript live regions used
// to be conditionally mounted (`{isActive && <Text aria-live=...>}`).
// NVDA / JAWS attach mutation observers when a live region node enters
// the DOM and then watch for text content changes on it. If the
// container is mounted alongside its first content, no observer is
// watching the parent at insertion time and the first announcement
// ("Connecting") is silently dropped. ARIA Live Regions spec
// (WAI-ARIA 1.2 §6.6.3) and WCAG 4.1.3 (Status Messages) require status
// transitions to be programmatically observable.
//
// The fix mounts both live regions at all times and toggles only the
// inner text (matching the existing pattern in InAppToast and
// ConnectionLiveRegion). This spec asserts the always-mounted invariant
// — the elements must be attached before voice activation and have
// empty text content; activation flips the content but not the mount.
test.describe("VoiceButton state live region is always mounted", () => {
  test.beforeEach(async ({ context }) => {
    // VoiceButton is gated on apiKey; seed a dummy value so the
    // microphone and state region render. Voice activation isn't
    // triggered in this spec (would require a real OpenAI Realtime
    // socket); we only assert the DOM invariant before activation.
    await context.addInitScript(() => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("tp_")) localStorage.removeItem(key);
        }
        localStorage.setItem("tp_voice_api_key", "sk-test-spec-not-real");
      } catch {
        // ignore
      }
    });
  });

  test("stateLabel and transcript live regions exist in DOM before voice activation", async ({
    page,
  }) => {
    await page.goto("/session/test-voice-live-region");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const stateRegion = page.getByTestId("voice-state-live-region");
    const transcriptRegion = page.getByTestId("voice-transcript-live-region");

    // Both live regions must be attached to the DOM *before* the user
    // ever activates voice — otherwise NVDA / JAWS miss the first
    // "Connecting" announcement because no observer was watching the
    // parent at the moment the node was inserted.
    await expect(stateRegion).toBeAttached();
    await expect(transcriptRegion).toBeAttached();

    // RN Web translates accessibilityLiveRegion="polite" to
    // aria-live="polite" on the rendered <div>.
    await expect(stateRegion).toHaveAttribute("aria-live", "polite");
    await expect(transcriptRegion).toHaveAttribute("aria-live", "polite");

    // Pre-activation: empty text content (idle state).
    await expect(stateRegion).toHaveText("");
    await expect(transcriptRegion).toHaveText("");

    // `display: none` would remove the node from the accessibility tree,
    // so NVDA / JAWS would never attach a mutation observer at page
    // load — and the first text insertion ("Connecting") would be
    // dropped silently. Empty text keeps the node visually inert
    // without hiding it from assistive tech. Assert the computed style
    // explicitly so a regression that re-introduces `display: none`
    // (or any equivalent like visibility:hidden / aria-hidden=true)
    // fails this spec.
    const stateDisplay = await stateRegion.evaluate(
      (el) => window.getComputedStyle(el).display,
    );
    const transcriptDisplay = await transcriptRegion.evaluate(
      (el) => window.getComputedStyle(el).display,
    );
    expect(stateDisplay).not.toBe("none");
    expect(transcriptDisplay).not.toBe("none");

    // aria-hidden=true would also remove the node from the a11y tree.
    // RN Web doesn't set aria-hidden by default; assert it's not
    // present (or, if present, not "true").
    const stateAriaHidden = await stateRegion.getAttribute("aria-hidden");
    const transcriptAriaHidden =
      await transcriptRegion.getAttribute("aria-hidden");
    expect(stateAriaHidden).not.toBe("true");
    expect(transcriptAriaHidden).not.toBe("true");
  });
});
