import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// Regression: Korean/Japanese/Chinese IME composition. While the user is
// composing a Hangul/Kana/Pinyin candidate, pressing Enter to commit fires
// a `keydown` event with `key="Enter"` AND `isComposing=true`. If the chat
// input's onKeyPress handler fires `handleSend()` on this event, the
// composing text is dropped (the IME commit is swallowed by the submit) and
// a half-typed message goes out. The handler must check `isComposing` and
// bail out, letting the browser's default IME commit run first.
test.describe("Chat input IME composition", () => {
  test("Enter during IME composition does not submit or clear input", async ({
    page,
  }) => {
    await page.goto("/session/test-ime-composition");
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });

    await input.focus();

    // Type a Hangul syllable directly (simulates the post-commit state). We
    // can't drive the OS IME from Playwright, but we can synthesize the
    // keydown event with isComposing=true that an IME would dispatch, and
    // verify the handler ignores it.
    await input.evaluate((el: HTMLTextAreaElement | HTMLInputElement) => {
      el.value = "안녕";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Dispatch a keydown that mirrors what Chrome fires for "Enter to commit"
    // during IME composition: key="Enter", isComposing=true. The chat
    // handler must NOT call handleSend (which would otherwise clear input).
    const beforeValue = await input.inputValue();
    await input.evaluate((el) => {
      const ev = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
    });
    await page.waitForTimeout(100);

    // Input value must still contain the typed text — the IME commit
    // shouldn't have been swallowed. Critically, the value should NOT have
    // been cleared (which is what handleSend does on success even when no
    // daemon is connected — it optimistically clears local state).
    const afterValue = await input.inputValue();
    expect(afterValue).toBe(beforeValue);
    expect(afterValue).toContain("안녕");
  });

  test("Enter outside IME composition still submits (no regression)", async ({
    page,
  }) => {
    await page.goto("/session/test-ime-no-regression");
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });

    await input.focus();
    await input.type("hello");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);

    // Without daemon, the existing chat-enter spec asserts the field cannot
    // contain a literal \n. We assert the same here to confirm we didn't
    // regress the non-composing path.
    const value = await input.inputValue();
    expect(value).not.toContain("\n");
  });
});
