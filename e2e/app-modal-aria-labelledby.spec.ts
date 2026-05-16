import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ModalContainer's dialogs expose `aria-label` on the dialog
// wrapper but NOT `aria-labelledby` pointing at the visible heading inside.
// Per APG Dialog Pattern §3.2.2, when a dialog contains a visible title
// element the dialog's accessible name MUST reference it via
// `aria-labelledby` so the screen reader can associate the spoken name with
// the rendered text. Using `aria-label` alone means the name is disconnected
// from the visible heading (a duplicate string that can drift on
// localisation or content changes). WCAG SC 4.1.2 requires programmatic
// association of Name, Role, Value.
//
// Fix: give the heading element a stable `id` inside each ModalContainer
// caller (FontSizeModal, FontPickerModal, ApiKeyModal, etc.) and set
// `aria-labelledby` on the dialog to that id, replacing the current
// `aria-label` duplicate.
test.describe("Modal dialogs aria-labelledby", () => {
  test("FontSizeModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Font Size modal
    await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"]'),
      );
      const row = rows.find((r) =>
        r.getAttribute("aria-label")?.startsWith("Font Size"),
      );
      row?.click();
    });

    // Wait for the dialog to appear
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The heading inside the dialog must have an id so it can be referenced
    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    // The dialog must use aria-labelledby pointing at the heading's id
    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });

  test("ApiKeyModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open API Key modal
    await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[aria-label]"),
      );
      const row = rows.find((el) =>
        el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
      );
      row?.click();
    });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });
});
