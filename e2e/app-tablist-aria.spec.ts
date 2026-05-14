import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the chat/terminal SegmentedControl carried only
// accessibilityRole="tabbar". RN propagates that verbatim, but "tabbar"
// is not a valid ARIA role — the standard is "tablist". Without the web
// override, browser DOM tooling and screen readers ignored the role and
// demoted the tab pair to plain buttons. The fix spreads role="tablist"
// on web only.
test.describe("SegmentedControl tablist ARIA", () => {
  test("session view tab container exposes role=tablist on web", async ({
    page,
  }) => {
    await page.goto("/session/test-tablist-role");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    // The tab container is the parent of the two tabs. Assert via the
    // parent chain so we don't depend on layout details.
    const tablist = await page.evaluate(() => {
      const chatTab = document.querySelector('[data-testid="tab-chat"]');
      const parent = chatTab?.parentElement;
      return parent?.getAttribute("role") ?? null;
    });
    expect(tablist).toBe("tablist");
  });
});
