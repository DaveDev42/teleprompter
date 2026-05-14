import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the chat Send button used `disabled={!input.trim() || !canSend}`
// which RN Web maps to native HTML `disabled`. Browsers skip
// `<button disabled>` in Tab order entirely, so a keyboard-only user
// typing into the composer would Tab past Send to whatever came next
// (often <body>) with no way back. The fix drops the native `disabled`
// prop and uses `aria-disabled` + an onPress guard, keeping the button
// focusable and announced as disabled.
test.describe("Chat Send button keyboard reachability", () => {
  test("Tab from chat input reaches Send button even when disabled", async ({
    page,
  }) => {
    await page.goto("/session/test-tab-to-send");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });
    await input.focus();

    // Composer is empty, so Send is disabled. Tab should still land on it.
    await page.keyboard.press("Tab");
    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(focusedTestId).toBe("chat-send");

    const send = page.getByTestId("chat-send");
    // aria-disabled must announce the disabled state even though we
    // dropped the native `disabled` attribute (which would have stripped
    // tab order). With no daemon paired in this synthetic session,
    // canSend stays false, so aria-disabled remains "true" regardless of
    // input content — that's expected and not what this test pins.
    const ariaWhenEmpty = await send.getAttribute("aria-disabled");
    expect(ariaWhenEmpty).toBe("true");

    // After typing, focus must remain on the input (Send button stays
    // reachable but we don't auto-focus it).
    await input.focus();
    await input.fill("hello");
    const focusedAfterFill = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(focusedAfterFill).toBe("chat-input");
  });
});
