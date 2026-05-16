import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: every other screen exposes a `role="main"` landmark so
// screen-reader users can jump straight to the body via landmark
// navigation (VoiceOver rotor / NVDA "G" key). The session detail view
// (`/session/[sid]`) was missed when role=main was added to the
// bottom-tab screens (#360) and the pairing routes (#366). Without it,
// AT users had to Tab past the back button, session header, and tab bar
// before reaching the chat log — defeating WCAG 2.4.1 Bypass Blocks.
//
// Fix: spread `role="main"` (web-only) on the root `KeyboardAvoidingView`
// of `apps/app/app/session/[sid].tsx`. Same pattern used on every other
// screen root.
test.describe("Session detail role=main landmark", () => {
  test("/session/[sid] has exactly one role=main landmark", async ({
    page,
  }) => {
    await page.goto("/session/test-session-main-landmark");
    await page.waitForLoadState("networkidle");

    const count = await page.locator('main, [role="main"]').count();
    expect(count).toBe(1);
  });
});
