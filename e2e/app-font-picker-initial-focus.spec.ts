import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ModalContainer's auto-focus picks the first focusable in DOM
// order. In FontPickerModal that's the trailing "Done" header button, so on
// open a screen reader announced "Done, button" instead of the current font
// option, and ArrowDown didn't do anything until the user Shift+Tab'd into
// the listbox. APG listbox guidance says focus should land on the
// currently-selected option, so add an initialFocusRef override that
// targets the active option.
test.describe("FontPickerModal initial focus", () => {
  test("opens with the current font option focused, not Done", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await page.getByText("Chat Font", { exact: true }).first().click();
    await page.getByRole("listbox", { name: /Chat Font/i }).waitFor();

    // ModalContainer focus timer is 100 ms; allow generous slack.
    await page.waitForFunction(
      () => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("data-testid") === "font-option-Inter";
      },
      undefined,
      { timeout: 2_000 },
    );

    // Sanity: the role and aria-selected match what a SR would announce.
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        role: el?.getAttribute("role"),
        selected: el?.getAttribute("aria-selected"),
        label: el?.getAttribute("aria-label"),
      };
    });
    expect(focused.role).toBe("option");
    expect(focused.selected).toBe("true");
    expect(focused.label).toBe("Inter");
  });
});
