import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session view's Chat/Terminal tabs both rendered with
// tabindex="0" regardless of which was selected. APG Tabs requires
// "roving tabindex" — only the active tab is in the document tab sequence
// (tabindex=0); the inactive one gets tabindex=-1 so Tab exits the
// tablist entirely instead of cycling inside it. Without roving tabindex
// a keyboard user has to Tab through every tab before reaching content
// below, and SR users lose the Tab vs Arrow distinction that signals
// tablist widget semantics.
test.describe("Session tab roving tabindex", () => {
  test("inactive tab has tabindex=-1, active tab has tabindex=0", async ({
    page,
  }) => {
    await page.goto("/session/test-roving-tabindex-initial");
    await page.waitForLoadState("networkidle");

    const chatTab = page.locator("#session-tab-chat");
    const termTab = page.locator("#session-tab-terminal");

    // Chat is the initial mode.
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("tabindex", "0");
    await expect(termTab).toHaveAttribute("aria-selected", "false");
    await expect(termTab).toHaveAttribute("tabindex", "-1");
  });

  test("roving tabindex follows the selected tab after Arrow navigation", async ({
    page,
  }) => {
    await page.goto("/session/test-roving-tabindex-arrow");
    await page.waitForLoadState("networkidle");

    await page.locator("#session-tab-chat").focus();
    await page.keyboard.press("ArrowRight");

    // Terminal is now active — it should be tabindex=0; Chat should be
    // tabindex=-1.
    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#session-tab-terminal")).toHaveAttribute(
      "tabindex",
      "0",
    );
    await expect(page.locator("#session-tab-chat")).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });
});
