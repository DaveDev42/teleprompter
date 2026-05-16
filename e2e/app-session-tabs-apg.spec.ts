import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session view's APG Tabs pattern was incomplete on two
// counts that broke real SR/keyboard flows.
//
// 1) The inactive tabpanel was conditionally unmounted, so the focused
//    tab's `aria-controls` pointed at an element that didn't exist in the
//    DOM. APG requires the referenced node to be present (hidden is fine,
//    missing is not), and dangling `aria-controls` confuses assistive
//    tech navigation that uses the relationship to jump to content.
//
// 2) ArrowRight/ArrowLeft/Home/End on the tablist did nothing — focus
//    stayed on the originally-focused tab. APG's automatic-activation
//    Tabs model requires those keys to cycle focus *and* activate the
//    focused tab. Without it a SR/keyboard user with focus on Chat has
//    no announced path to Terminal short of tab-cycling out of the
//    tablist entirely.
test.describe("Session view APG Tabs", () => {
  test("both tabpanels stay mounted so aria-controls targets always exist", async ({
    page,
  }) => {
    await page.goto("/session/test-apg-tabs-mount");
    await page.waitForLoadState("networkidle");

    // The two tabs claim two distinct panel ids via aria-controls.
    const tabChat = page.locator("#session-tab-chat");
    const tabTerm = page.locator("#session-tab-terminal");
    await expect(tabChat).toHaveAttribute(
      "aria-controls",
      "session-tabpanel-chat",
    );
    await expect(tabTerm).toHaveAttribute(
      "aria-controls",
      "session-tabpanel-terminal",
    );

    // Both panel containers are in the DOM regardless of which tab is
    // active. The inactive one carries the `hidden` attribute (collapses
    // layout, removes from a11y tree).
    const chatPanelExists = await page.evaluate(
      () => !!document.getElementById("session-tabpanel-chat"),
    );
    const termPanelExists = await page.evaluate(
      () => !!document.getElementById("session-tabpanel-terminal"),
    );
    expect(chatPanelExists).toBe(true);
    expect(termPanelExists).toBe(true);
  });

  test("ArrowRight on the tablist activates and focuses the next tab", async ({
    page,
  }) => {
    await page.goto("/session/test-apg-tabs-arrow-nav");
    await page.waitForLoadState("networkidle");

    // Land focus on the Chat tab — the entry point for keyboard nav into
    // the tablist.
    await page.locator("#session-tab-chat").focus();
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // ArrowRight should both activate Terminal *and* move focus to it.
    await page.keyboard.press("ArrowRight");

    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    // Focus moves inside requestAnimationFrame on the app side (so the
    // newly-selected tab has the updated aria-selected attribute before
    // it receives focus). Poll for it instead of reading once — a single
    // `page.evaluate` would race with the rAF callback.
    //
    // GhosttyTerminal mounts when the Terminal tab becomes active and
    // may steal focus from the tab to its own container (terminal-container)
    // so the canvas is keyboard-ready. Both outcomes are valid: the tab
    // briefly held focus before GhosttyTerminal mounted, or GhosttyTerminal
    // has already taken over. Verify focus left the chat tab and landed
    // somewhere inside the terminal area (tab or container).
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? null,
        ),
      )
      .toMatch(/^(tab-terminal|terminal-container)$/);

    // ArrowLeft cycles back. The terminal tab is active going in, so
    // the rAF focus move lands on the chat tab which has no competing
    // auto-focus, so the id check is reliable here.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.getAttribute("id") ?? null),
      )
      .toBe("session-tab-chat");
  });
});
