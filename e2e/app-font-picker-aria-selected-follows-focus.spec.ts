import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontPickerModal previously set `aria-selected` to the
// *committed* font (`isCurrent`) rather than the *focused* option
// (`isActive`). The WAI-ARIA APG single-select listbox pattern says
// `aria-selected` must follow keyboard focus — otherwise a screen
// reader user pressing ArrowDown hears "Inter, option, 2 of 6, not
// selected" because aria-selected never moves off the originally-
// committed option. The committed font is still surfaced visually via
// the trailing check mark and remains the source of truth until the
// user activates an option with Enter / click.
test.describe("FontPickerModal aria-selected follows keyboard focus", () => {
  test("ArrowDown moves aria-selected onto the newly focused option", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await page
      .getByText(/Chat Font/i)
      .first()
      .click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    const options = listbox.getByRole("option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // The currently-committed option starts with the roving tabindex
    // and is focused via .focus() on the first option. Whatever option
    // currently has aria-selected=true is the active one — capture its
    // textContent so we can assert it loses aria-selected after
    // ArrowDown.
    const firstOption = options.first();
    await firstOption.focus();

    // Pre-condition: the focused option carries aria-selected="true".
    // (Same option both has DOM focus and is the active descendant in
    // the listbox.)
    await expect(firstOption).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");

    // Post-condition: the newly focused option must carry
    // aria-selected="true" and the previously focused option must
    // carry aria-selected="false". This is the core APG invariant —
    // aria-selected follows focus, not commit state.
    const secondOption = options.nth(1);
    await expect(secondOption).toHaveAttribute("aria-selected", "true");
    await expect(firstOption).toHaveAttribute("aria-selected", "false");
  });
});
