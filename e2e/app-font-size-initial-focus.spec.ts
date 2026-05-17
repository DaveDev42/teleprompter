import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `FontSizeModal` in `apps/app/src/components/FontPickerModal.tsx`
// opens without an explicit `initialFocusRef`, so `ModalContainer`'s
// fallback heuristic (focusable[0] unless it finds INPUT/TEXTAREA) picks
// the first focusable element in DOM order — the "Done" header button —
// instead of the primary `role="spinbutton"` widget. A keyboard user
// would have to Shift+Tab back to the spinbutton before they can press
// ArrowUp/ArrowDown to change the font size.
//
// Sibling `FontPickerModal` (same file) already passes
// `initialFocusRef={initialFocusRef}` to ModalContainer; this case was
// overlooked. `sizeRef` is already declared and attached to the
// spinbutton View — wire it into ModalContainer's initialFocusRef prop.
//
// APG Dialog §3.2.1: "When a dialog opens, focus moves to an element
// inside the dialog … on the input or interactive control that
// facilitates … the UI change."
// WCAG 2.4.3 Focus Order (Level A).
// WCAG 2.1.1 Keyboard (Level A).
test.describe("FontSizeModal initial focus lands on spinbutton", () => {
  test("opening FontSizeModal focuses role=spinbutton, not Done button", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open the modal by clicking the Font Size row.
    const fontSizeRow = page.getByRole("button", { name: /^Font Size,/ });
    await fontSizeRow.click();

    // Wait for the dialog to mount.
    await page.waitForSelector('[role="dialog"]', { state: "visible" });

    // ModalContainer auto-focuses after a 100 ms timer — give it room.
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el?.getAttribute("role") === "spinbutton";
    });

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        role: el?.getAttribute("role") ?? null,
        tagName: el?.tagName.toLowerCase() ?? null,
        label: el?.getAttribute("aria-label") ?? null,
      };
    });

    expect(focused.role).toBe("spinbutton");
    expect(focused.label).toBe("Font size in pixels");
  });

  test("ArrowUp immediately increments font size with no intermediate Tab", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByRole("button", { name: /^Font Size,/ });
    await fontSizeRow.click();
    await page.waitForSelector('[role="spinbutton"]', { state: "visible" });

    // Wait for spinbutton auto-focus to settle.
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el?.getAttribute("role") === "spinbutton";
    });

    const before = await page
      .locator('[role="spinbutton"]')
      .getAttribute("aria-valuenow");

    await page.keyboard.press("ArrowUp");

    // Allow React state update + RN Web re-render.
    await page.waitForFunction((prev) => {
      const el = document.querySelector('[role="spinbutton"]');
      const cur = el?.getAttribute("aria-valuenow");
      return cur !== prev;
    }, before);

    const after = await page
      .locator('[role="spinbutton"]')
      .getAttribute("aria-valuenow");

    expect(Number(after)).toBe(Number(before) + 1);
  });
});
