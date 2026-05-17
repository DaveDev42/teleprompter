import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: VoiceButton's state and transcript live regions used
// `accessibilityLiveRegion="polite"` alone. RN Web translates that to
// `aria-live="polite"` on a generic `<div>`, but does NOT add
// `role="status"`. Without role=status the element lacks the implicit
// `aria-atomic="true"` semantics — NVDA/JAWS announce text changes
// inconsistently and treat the region as a generic polite live region
// rather than a status message (ARIA 1.2 §6.3.27, WCAG 4.1.3 Status
// Messages, Level AA).
//
// Every other polite live region in the codebase already wires
// `role="status"` explicitly on web: InAppToast.tsx line ~58,
// ConnectionLiveRegion in session/[sid].tsx, SessionStoppedLiveRegion,
// the themeAnnouncementRef block in settings.tsx. VoiceButton is the
// outlier this spec defends against.
test.describe("VoiceButton live regions expose role=status on web", () => {
  test.beforeEach(async ({ context }) => {
    // VoiceButton is gated on apiKey; seed a dummy value so the live
    // regions render. Activation isn't required for this spec — we
    // assert the static DOM attributes.
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

  test("voice state + transcript regions carry role=status and aria-live=polite", async ({
    page,
  }) => {
    await page.goto("/session/test-voice-role-status");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const stateRegion = page.getByTestId("voice-state-live-region");
    const transcriptRegion = page.getByTestId("voice-transcript-live-region");

    await expect(stateRegion).toBeAttached();
    await expect(transcriptRegion).toBeAttached();

    // Both must carry role=status — that's the ARIA 1.2 status-message
    // semantic that brings implicit aria-atomic=true and tells AT to
    // treat updates as status announcements (not generic polite live
    // region text changes).
    await expect(stateRegion).toHaveAttribute("role", "status");
    await expect(transcriptRegion).toHaveAttribute("role", "status");

    // aria-live=polite must still be present — explicit + implicit
    // reinforce each other and survive both NVDA/JAWS quirks and any
    // future RN Web change that stops mapping accessibilityLiveRegion.
    await expect(stateRegion).toHaveAttribute("aria-live", "polite");
    await expect(transcriptRegion).toHaveAttribute("aria-live", "polite");
  });
});
