import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// FontPickerModal exposes role="listbox" with role="option" children but
// previously had no keyboard handler — ArrowDown from a focused option
// jumped focus to the next thing in tab order (the "Done" button or the
// body), violating the ARIA APG listbox keyboard pattern. The fix
// implements a roving tabindex on the options and intercepts
// ArrowDown / ArrowUp / Home / End on the listbox container to move
// focus among options without leaving the listbox.

test.describe("FontPickerModal keyboard navigation (APG listbox pattern)", () => {
  test("ArrowDown moves focus to next option, not out of the listbox", async ({
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

    // Focus the currently-selected option (the one with tabIndex=0 under
    // the roving-tabindex pattern). Tabbing from the Done button lands
    // on the listbox option that owns the current tab stop.
    const firstOption = options.first();
    await firstOption.focus();

    await page.keyboard.press("ArrowDown");

    const focusedRole = await page.evaluate(
      () => document.activeElement?.getAttribute("role") ?? null,
    );
    expect(focusedRole).toBe("option");

    const focusedText = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? null,
    );
    const secondOptionText = (await options.nth(1).textContent())?.trim();
    expect(focusedText).toBe(secondOptionText);
  });

  test("Home key jumps to first option, End to last", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page
      .getByText(/Chat Font/i)
      .first()
      .click();

    const options = page.getByRole("listbox").getByRole("option");
    const last = (await options.count()) - 1;
    await options.nth(0).focus();

    await page.keyboard.press("End");
    let role = await page.evaluate(
      () => document.activeElement?.getAttribute("role") ?? null,
    );
    let text = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? null,
    );
    const lastText = (await options.nth(last).textContent())?.trim();
    expect(role).toBe("option");
    expect(text).toBe(lastText);

    await page.keyboard.press("Home");
    role = await page.evaluate(
      () => document.activeElement?.getAttribute("role") ?? null,
    );
    text = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? null,
    );
    const firstText = (await options.nth(0).textContent())?.trim();
    expect(role).toBe("option");
    expect(text).toBe(firstText);
  });
});
