import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: VoiceButton's "Include terminal context" toggle renders as
// <div role="switch"> (RN Web Pressable doesn't emit a native <button>),
// so the browser's "Space clicks the focused button" shortcut doesn't
// apply. Enter happened to work via Pressable's synthetic onClick, but
// Space fell through silently — yet WAI-ARIA §3.22 (Switch Pattern) and
// WCAG 2.1.1 designate Space as the canonical activator for role=switch.
// Screen reader users on NVDA/JAWS/VoiceOver press Space to toggle.
test.describe("VoiceButton terminal switch keyboard activation", () => {
  test.beforeEach(async ({ context }) => {
    // VoiceButton is gated on apiKey; seed a dummy value before the page
    // script reads localStorage. The actual key is `tp_voice_api_key`
    // (secure-storage prepends `tp_` to the bare key on web).
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

  test("Space toggles aria-checked on the terminal context switch", async ({
    page,
  }) => {
    await page.goto("/session/test-voice-switch-space");
    await page.waitForLoadState("networkidle");

    const toggle = page.getByRole("switch", {
      name: "Include terminal context",
    });
    await expect(toggle).toBeAttached({ timeout: 5_000 });
    await toggle.focus();

    const initial = await toggle.getAttribute("aria-checked");
    expect(initial).toBe("false");

    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("Enter still toggles the switch (existing onPress path)", async ({
    page,
  }) => {
    await page.goto("/session/test-voice-switch-enter");
    await page.waitForLoadState("networkidle");

    const toggle = page.getByRole("switch", {
      name: "Include terminal context",
    });
    await expect(toggle).toBeAttached({ timeout: 5_000 });
    await toggle.focus();

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
