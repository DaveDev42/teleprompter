import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the SegmentedControl exposed role=tab + aria-selected but no
// id/aria-controls, and the ChatView / TerminalView weren't wrapped in
// role=tabpanel with aria-labelledby. Without that bidirectional link the
// APG Tabs pattern is incomplete — a screen reader user can hear "tab,
// selected" but the content region underneath isn't announced as the
// matching panel, so navigation between tabs and panel content is opaque.
test.describe("Session view APG Tabs pattern", () => {
  test("Chat tab is wired to a role=tabpanel via aria-controls / aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/session/test-tabpanel-aria");
    await page.getByTestId("tab-chat").waitFor({ timeout: 10_000 });

    const wiring = await page.evaluate(() => {
      const tab = document.querySelector('[data-testid="tab-chat"]');
      const tabId = tab?.getAttribute("id");
      const controls = tab?.getAttribute("aria-controls");
      if (!controls) return { tabId, controls, panelLabelledBy: null };
      const panel = document.getElementById(controls);
      return {
        tabId,
        controls,
        panelRole: panel?.getAttribute("role") ?? null,
        panelLabelledBy: panel?.getAttribute("aria-labelledby") ?? null,
      };
    });

    expect(wiring.tabId).toBe("session-tab-chat");
    expect(wiring.controls).toBe("session-tabpanel-chat");
    expect(wiring.panelRole).toBe("tabpanel");
    expect(wiring.panelLabelledBy).toBe("session-tab-chat");
  });

  test("Terminal tab is wired to a role=tabpanel after switching modes", async ({
    page,
  }) => {
    await page.goto("/session/test-tabpanel-aria-terminal");
    await page.getByTestId("tab-terminal").waitFor({ timeout: 10_000 });

    // The terminal panel only mounts when the terminal tab is active —
    // verify both that the tab has the right wiring and that activating
    // it surfaces a matching tabpanel in the DOM.
    const tabWiring = await page.evaluate(() => {
      const tab = document.querySelector('[data-testid="tab-terminal"]');
      return {
        id: tab?.getAttribute("id") ?? null,
        controls: tab?.getAttribute("aria-controls") ?? null,
      };
    });
    expect(tabWiring.id).toBe("session-tab-terminal");
    expect(tabWiring.controls).toBe("session-tabpanel-terminal");

    await page.getByTestId("tab-terminal").click();

    await page.waitForFunction(
      () => {
        const panel = document.getElementById("session-tabpanel-terminal");
        return (
          panel?.getAttribute("role") === "tabpanel" &&
          panel?.getAttribute("aria-labelledby") === "session-tab-terminal"
        );
      },
      undefined,
      { timeout: 5_000 },
    );
  });
});
