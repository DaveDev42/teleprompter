import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: session view's Chat / Terminal tabpanels were both
// permanently exposed to assistive tech. The JSX passed
// `hidden={mode !== "chat"}` to the inactive panel `<View>`, but RN
// Web's createDOMProps does not include `hidden` in its allowed
// attribute pass-through list — the prop was silently dropped and
// the attribute never landed on the DOM. The inactive tabpanel
// stayed in the accessibility tree with `display: flex`, so a screen
// reader user on the Chat tab would also hear the Terminal panel's
// content as if both were active. APG Tabs §3.23 requires the
// inactive tabpanel to be removed from AT navigation; the canonical
// mechanism is the HTML `hidden` attribute.
//
// The fix mirrors the imperative-setAttribute pattern used elsewhere
// (ApiKeyModal aria-description, RenamePairingModal aria-description,
// SessionStoppedLiveRegion aria-atomic) — attach refs to both tabpanel
// `<View>` nodes and toggle `hidden` from a useEffect on `mode` flips.
test.describe("Session view tabpanel hidden attribute", () => {
  test("inactive tabpanel carries the hidden HTML attribute on web", async ({
    page,
  }) => {
    await page.goto("/session/test-tabpanel-hidden");
    await page.waitForLoadState("networkidle");

    const chatPanel = page.locator("#session-tabpanel-chat");
    const terminalPanel = page.locator("#session-tabpanel-terminal");

    // Chat is the default active tab on session entry.
    await expect(chatPanel).toBeVisible();

    // The active panel must NOT have hidden; the inactive one MUST.
    // Without this, screen readers will read the Terminal content as
    // part of the Chat tabpanel because both panels are in the AT
    // tree simultaneously.
    await expect(chatPanel).not.toHaveAttribute("hidden", /.*/);
    await expect(terminalPanel).toHaveAttribute("hidden", /.*/);

    // Switch to Terminal — the hidden attribute must flip.
    await page.locator("#session-tab-terminal").click();

    await expect(terminalPanel).not.toHaveAttribute("hidden", /.*/);
    await expect(chatPanel).toHaveAttribute("hidden", /.*/);
  });
});
