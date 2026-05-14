import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: pairing/index.tsx used `disabled={!canSubmit}` on the
// Connect Pressable, which RN Web maps to native HTML `disabled`. The
// browser then skips it in Tab order, so after Tab landing on the
// pairing textarea the next Tab goes straight to <body> with no way to
// reach Connect by keyboard. Same fix as the chat Send button: drop
// native `disabled`, mirror aria-disabled via ref + useEffect, gate the
// onPress handler.
test.describe("Pairing Connect button keyboard reachability", () => {
  test("Tab from pairing textarea reaches Connect even when disabled", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.waitFor({ timeout: 10_000 });
    await textarea.focus();

    await page.keyboard.press("Tab");
    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(focusedTestId).toBe("pairing-connect");

    const connect = page.getByTestId("pairing-connect");
    await expect(connect).toHaveAttribute("aria-disabled", "true");

    // Typing valid-shaped input flips aria-disabled off (Connect remains
    // focusable either way — the regression is only about Tab order).
    await textarea.fill("placeholder");
    await expect(connect).not.toHaveAttribute("aria-disabled", "true");
  });
});
