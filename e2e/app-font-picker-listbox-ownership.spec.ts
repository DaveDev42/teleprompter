import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: FontPickerModal used FlatList, which wraps each cell in
// three generic <div>s between the role="listbox" container and the
// role="option" Pressable. ARIA's required-context rule (§4.3.3) says
// a listbox must directly own its options. Chromium auto-repairs that
// ownership but Firefox/Safari are less forgiving, so the options can
// drop out of the AX tree for NVDA/JAWS/VoiceOver. Fix: replace
// FlatList with ScrollView + .map() so the option nodes sit at most
// one wrapper deep from the listbox.
test.describe("FontPickerModal listbox/option ownership", () => {
  test("each option is a direct or single-wrapper child of the listbox", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Chat Font picker.
    await page.getByRole("button", { name: /^Chat Font/ }).click();

    // Wait for the listbox to mount.
    const listbox = page.locator('[role="listbox"][aria-label="Chat Font"]');
    await expect(listbox).toBeAttached({ timeout: 5_000 });

    // For every option, count generic ancestors up to the listbox.
    // ScrollView still emits one outer wrapper div; we accept ≤1.
    // FlatList emitted three, which is what we're guarding against.
    const maxDepth = await page.evaluate(() => {
      const lb = document.querySelector(
        '[role="listbox"][aria-label="Chat Font"]',
      );
      if (!lb) return -1;
      const options = Array.from(lb.querySelectorAll('[role="option"]'));
      if (options.length === 0) return -1;
      let max = 0;
      for (const opt of options) {
        let depth = 0;
        let node: Element | null = opt.parentElement;
        while (node && node !== lb) {
          depth++;
          node = node.parentElement;
        }
        if (depth > max) max = depth;
      }
      return max;
    });

    // Accept 0 (direct child) or 1 (single ScrollView wrapper).
    // Anything ≥2 means the FlatList nesting regressed back.
    expect(maxDepth).toBeGreaterThanOrEqual(0);
    expect(maxDepth).toBeLessThanOrEqual(1);
  });
});
