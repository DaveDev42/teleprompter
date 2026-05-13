import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// Regression: react-native-web's multiline TextInput inserts a newline on Enter
// regardless of returnKeyType, so the chat input has an explicit onKeyPress
// handler that maps Enter → submit and Shift+Enter → newline.
test.describe("Chat input Enter-to-send", () => {
  test("Enter on chat input does not insert a newline (it submits)", async ({
    page,
  }) => {
    await page.goto("/session/test-enter-submit");
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });

    await input.focus();
    await input.type("hello");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);

    // Without a daemon connection handleSend silently no-ops on the send side,
    // but the keystroke handler still preventDefaults the newline. So either
    // the input was cleared (send fired) OR it still says "hello" — what
    // matters is that it MUST NOT contain a literal "\n".
    const value = await input.inputValue();
    expect(value).not.toContain("\n");
  });

  test("Shift+Enter on chat input inserts a newline (does not submit)", async ({
    page,
  }) => {
    await page.goto("/session/test-shift-enter");
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 10_000 });

    await input.focus();
    await input.type("line1");
    await page.keyboard.press("Shift+Enter");
    await input.type("line2");

    const value = await input.inputValue();
    expect(value).toMatch(/line1\n+line2/);
  });
});
