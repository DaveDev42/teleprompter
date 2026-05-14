import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontPickerModal items used role=button + aria-selected, which
// is incorrect ARIA (aria-selected is only valid on listbox option, tab,
// gridcell, row, treeitem, columnheader, rowheader). The modal now exposes
// a role=listbox container with role=option children carrying aria-selected.
// Verifies (a) the parent has role=listbox, (b) the current font option is
// aria-selected=true, and (c) non-current options are aria-selected=false.
test.describe("Font picker accessibility", () => {
  test("listbox/option pattern with aria-selected", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the Chat Font picker by tapping the row.
    const chatFontRow = page.getByText("Chat Font", { exact: true }).first();
    await expect(chatFontRow).toBeVisible();
    await chatFontRow.click();

    // Parent listbox is present.
    const listbox = page.getByRole("listbox", { name: /Chat Font/i });
    await expect(listbox).toBeVisible();

    // Inter is the default chat font — aria-selected=true.
    const inter = page.getByRole("option", { name: /^Inter$/ });
    await expect(inter).toBeVisible();
    await expect(inter).toHaveAttribute("aria-selected", "true");

    // Non-current options must report aria-selected="false".
    const helvetica = page.getByRole("option", { name: /^Helvetica Neue$/ });
    await expect(helvetica).toHaveAttribute("aria-selected", "false");
  });
});
