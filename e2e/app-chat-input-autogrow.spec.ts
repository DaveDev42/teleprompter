import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RN Web's `multiline` TextInput renders as <textarea rows="2">
// with a fixed clientHeight (~52px). Shift+Enter newlines stack invisibly
// inside the pill — users type 6 lines and see only the last 2. The fix
// imperatively resets height="auto" then sets it to scrollHeight on every
// input change, letting CSS max-height take over for the scroll cap.
test.describe("Chat input auto-grow", () => {
  test("textarea height grows when user adds newlines (Shift+Enter)", async ({
    page,
  }) => {
    await page.goto("/session/test-autogrow");
    await page.waitForLoadState("networkidle");

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await input.focus();

    const baselineHeight = await input.evaluate(
      (el) => (el as HTMLTextAreaElement).clientHeight,
    );

    // Type a multi-line message. Avoid Enter (would submit the chat) —
    // instead, set the value directly via the framework's input event so
    // React's controlled component picks it up.
    await input.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(ta, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Give the effect a tick to run.
    await page.waitForTimeout(50);

    const grownHeight = await input.evaluate(
      (el) => (el as HTMLTextAreaElement).clientHeight,
    );

    expect(grownHeight).toBeGreaterThan(baselineHeight);
  });
});
