import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: VoiceButton renders two `accessibilityLiveRegion="polite"`
// Text nodes — one for the state label (connecting → listening → processing)
// and one for the transcript stream. ARIA 1.2 §6.3.2 says role=status
// implies `aria-atomic="true"`, but NVDA / JAWS ignore the implicit value
// and announce only the diff between updates. When the state transitions
// from "Connecting" to "Listening" without aria-atomic, the user only hears
// "Listening" with no leading context — and the first word of an incoming
// transcript can be dropped entirely.
//
// RN Web 0.21 silently drops prop-level `aria-atomic` on Text/View. The fix
// (in `apps/app/src/components/VoiceButton.tsx`) applies the attribute
// imperatively in a useEffect via setAttribute on a ref'd element. Matches
// the InAppToast / ConnectionLiveRegion / theme-announcement /
// DiagnosticsPanel pattern. WCAG 4.1.3 Status Messages.
test.describe("VoiceButton live regions", () => {
  test("voice state + transcript live regions have aria-atomic=true", async ({
    page,
  }) => {
    // Seed the API key before the app boots so VoiceButton renders.
    // secure-storage on web uses the `tp_` prefix on localStorage.
    await page.addInitScript(() => {
      localStorage.setItem("tp_voice_api_key", "sk-test-fixture");
    });

    await page.goto("/session/test-voice-live-region-atomic");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const stateRegion = page.getByTestId("voice-state-live-region");
    const transcriptRegion = page.getByTestId("voice-transcript-live-region");

    await expect(stateRegion).toBeAttached({ timeout: 5_000 });
    await expect(transcriptRegion).toBeAttached({ timeout: 5_000 });

    await expect(stateRegion).toHaveAttribute("aria-atomic", "true");
    await expect(transcriptRegion).toHaveAttribute("aria-atomic", "true");
  });
});
