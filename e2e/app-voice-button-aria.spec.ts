import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: VoiceButton's terminal-context switch passed `checked` only
// via accessibilityState. RN Web's createDOMProps emits aria-checked only
// when the prop is on the element directly, so a screen reader landing on
// the switch wouldn't know if terminal context was on or off. The fix
// spreads aria-checked on web. The same pattern applies to the mic
// Pressable's aria-busy; covering one site is enough to lock the regression
// since the helper is shared. We use the switch because aria-checked
// round-trips cleanly via a click while aria-busy=true would require
// triggering real mic capture.
test.describe("VoiceButton ARIA", () => {
  test("terminal-context switch toggles aria-checked on web", async ({
    page,
  }) => {
    // Seed the API key before the app boots so VoiceButton renders.
    // secure-storage on web uses the `tp_` prefix on localStorage.
    await page.addInitScript(() => {
      localStorage.setItem("tp_voice_api_key", "sk-test-fixture");
    });

    await page.goto("/session/test-voice-aria");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const termSwitch = page.locator('[aria-label="Include terminal context"]');
    await expect(termSwitch).toBeVisible({ timeout: 5_000 });
    await expect(termSwitch).toHaveAttribute("aria-checked", "false");

    await termSwitch.click();
    await expect(termSwitch).toHaveAttribute("aria-checked", "true");
  });

  // Regression: the `connecting` state used "..." as both the visible label
  // and the screen-reader announcement. VoiceOver and NVDA both expand bare
  // "..." into "dot dot dot", which is meaningless during a brief connection
  // hop. The fix uses the word "Connecting" so both the visible Text and the
  // aria-label round-trip the same human-readable state. The state is set
  // synchronously inside startVoice() (before any async getUserMedia work)
  // so we can assert immediately after the click without needing a real mic.
  test("connecting state announces 'Connecting' not '...'", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("tp_voice_api_key", "sk-test-fixture");
    });

    await page.goto("/session/test-voice-connecting");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const mic = page.locator('[aria-label="Start voice input"]');
    await expect(mic).toBeVisible({ timeout: 5_000 });
    await mic.click();

    // After click, the same Pressable's aria-label flips to the active form.
    const activeMic = page.locator('[aria-label="Stop voice, Connecting"]');
    await expect(activeMic).toBeVisible({ timeout: 5_000 });

    // No element should expose the bare "..." as its accessible name.
    await expect(page.locator('[aria-label="Stop voice, ..."]')).toHaveCount(0);
  });
});
