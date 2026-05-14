import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ModalContainer's content View used to carry only
// accessibilityLabel. RN doesn't recognise accessibilityRole="dialog"
// (not in its allowlist) and silently drops accessibilityViewIsModal on
// web, so screen readers announced the label as a region instead of a
// dialog and the virtual cursor wandered outside the modal even though
// keyboard focus was trapped. The fix spreads role="dialog" +
// aria-modal="true" directly on web.
test.describe("ModalContainer dialog ARIA", () => {
  test("ApiKeyModal surface exposes role=dialog and aria-modal", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("tab-settings").waitFor({ timeout: 30_000 });
    await page.getByTestId("tab-settings").click();
    await page.locator("text=Appearance").waitFor({ timeout: 5_000 });

    // Open ApiKeyModal — the row's accessibilityLabel starts with the
    // surface name. Click the first matching element.
    await page.evaluate(() => {
      (
        Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
          el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
        ) as HTMLElement | undefined
      )?.click();
    });

    // Modal content surface is identified by its aria-label.
    const dialog = page.locator('[role="dialog"][aria-label="OpenAI API Key"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Exactly one role=dialog should be on the page. RN Web's <Modal>
    // hard-codes role=dialog + aria-modal on its outer wrapper; we used to
    // add a second role=dialog on our inner card, producing two unnamed
    // and named dialogs in the a11y tree. The label now lives on the
    // single Modal wrapper.
    const allDialogs = page.locator('[role="dialog"]');
    await expect(allDialogs).toHaveCount(1);
  });
});
