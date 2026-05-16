import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontPickerModal's `role="option"` Pressables render as
// <div> on web (RN Web's Pressable doesn't emit a native <button>),
// so the browser's "Space clicks a focused button" shortcut doesn't
// apply. Enter happens to work because Pressable's synthetic onClick
// catches it, but Space fell through with no effect — keyboard-only
// users could navigate with ArrowDown/Up but couldn't commit the
// focused font.
//
// APG Single-Select Listbox §3.14 requires Space on a focused option
// to commit the selection. The fix adds a " " branch to the listbox
// onKeyDown handler that click()s the active option's DOM ref,
// routing through Pressable's existing onPress (onSelect + onClose).
test.describe("FontPickerModal Space activates focused option", () => {
  test("Space on a focused option commits the font and closes the modal", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the Chat Font picker.
    await page
      .getByText(/Chat Font/i)
      .first()
      .click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    const options = listbox.getByRole("option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Focus the first option, ArrowDown to the second so focus moves
    // off whatever is currently committed.
    await options.first().focus();
    await page.keyboard.press("ArrowDown");

    // The second option must own focus + aria-selected before Space.
    const focused = options.nth(1);
    await expect(focused).toBeFocused();
    await expect(focused).toHaveAttribute("aria-selected", "true");
    const committedName = (await focused.textContent())?.trim() ?? "";
    expect(committedName.length).toBeGreaterThan(0);

    // Space must commit the focused option's font and close the
    // modal. Without this fix, Space falls through and the listbox
    // stays open with the original font still committed.
    await page.keyboard.press(" ");

    // Modal must close.
    await expect(listbox).not.toBeVisible();

    // Reopen the modal — the previously-focused font must now be
    // the committed one (gets the ✓ check mark). Asserting on the
    // ✓ marker is more robust than asserting on document.activeElement
    // because initialFocusRef timing is exercised by a separate spec
    // (app-font-picker-initial-focus).
    await page
      .getByText(/Chat Font/i)
      .first()
      .click();

    const reopened = page.getByRole("listbox");
    await expect(reopened).toBeVisible();
    const reopenedOptions = reopened.getByRole("option");
    // The option whose name matches committedName must own the ✓
    // marker (committed font surface), confirming Space did persist
    // the new selection rather than no-op.
    const committedOption = reopenedOptions.filter({
      hasText: new RegExp(`^${committedName}\\s*✓$`),
    });
    await expect(committedOption).toHaveCount(1);
  });
});
