import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the chat messages live region was declared with
// `aria-live="polite"` + `aria-relevant="additions"`, but RN Web's
// createDOMProps silently drops `aria-relevant` — it never reaches the
// DOM. Worse, without a landmark role AT doesn't know the region is a
// chat transcript. `role="log"` implies both `aria-live=polite` and
// `aria-relevant=additions text` per ARIA spec, so switching to it
// fixes both gaps in a single attribute.
test.describe("Session chat messages role=log", () => {
  test("chat messages container has role=log on web", async ({ page }) => {
    await page.goto("/session/test-chat-log-role");
    await page.waitForLoadState("networkidle");

    // role=log is set on the wrapping View around the FlatList. There
    // should be exactly one log landmark inside the session view.
    const log = page.locator('[role="log"]');
    await expect(log).toBeVisible();

    // role=log implies aria-live=polite + aria-relevant=additions text
    // per ARIA spec, so AT picks up new messages without an explicit
    // aria-live attribute. We don't assert aria-live here because the
    // implicit value isn't always serialized to DOM — what matters is
    // that the landmark role is present.
  });
});
