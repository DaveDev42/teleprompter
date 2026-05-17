import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `FontSizeModal` in `apps/app/src/components/FontPickerModal.tsx`
// renders bare "−" (U+2212 MINUS SIGN) and "+" (U+002B PLUS SIGN) inside
// Pressables that carry `accessibilityLabel="Decrease font size"` and
// `accessibilityLabel="Increase font size"`. ARIA 1.2 says `aria-label`
// replaces the accessible name on the labelled element, but
// `role="button"` is NOT atomic for virtual-cursor navigation in NVDA
// browse mode and JAWS reading cursor — the cursor descends into the
// child Text and announces "minus sign" / "plus sign" as a separate
// readout after the button's name.
//
// WCAG 1.1.1 (Non-text Content, Level A): the glyphs are decorative —
// the accessibilityLabel already conveys the action. Hide from AT on
// web. Native AT (VoiceOver/TalkBack) focuses the parent Pressable and
// reads accessibilityLabel directly, so the gate is web-only.
//
// DOM-level invariant: open the FontSizeModal from `/settings`, scan
// every `[role="button"][aria-label]` for a descendant whose OWN text
// is "−" or "+", and assert it (or an ancestor inside the button) has
// `aria-hidden="true"`.
test("FontSizeModal ± glyphs carry aria-hidden on web", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  // Open the FontSizeModal by clicking the "Font Size" row.
  await page.getByRole("button", { name: /^Font Size,/ }).click();
  // Wait for the Decrease/Increase buttons to mount.
  await page
    .getByRole("button", { name: "Decrease font size" })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Increase font size" })
    .waitFor({ state: "visible" });

  const leaks = await page.evaluate(() => {
    const targets = new Set(["−", "+"]);
    const found: Array<{
      parentLabel: string;
      glyph: string;
      ariaHidden: string | null;
    }> = [];
    const buttons = document.querySelectorAll('[role="button"][aria-label]');
    for (const button of Array.from(buttons)) {
      for (const child of Array.from(button.querySelectorAll("*"))) {
        // Only flag the leaf element whose OWN text node content matches —
        // wrapper Views that contain a glyph descendant share the same
        // textContent but are not the AT-visible element.
        const ownText = Array.from(child.childNodes)
          .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (!targets.has(ownText)) continue;
        // Check the child and its ancestors up to (but not including)
        // the button for aria-hidden="true".
        let cursor: Element | null = child;
        let hidden = false;
        while (cursor && cursor !== button) {
          if (cursor.getAttribute("aria-hidden") === "true") {
            hidden = true;
            break;
          }
          cursor = cursor.parentElement;
        }
        if (!hidden) {
          found.push({
            parentLabel: button.getAttribute("aria-label") ?? "",
            glyph: ownText,
            ariaHidden: child.getAttribute("aria-hidden"),
          });
        }
      }
    }
    return found;
  });

  expect(leaks).toEqual([]);

  // Sanity: both glyphs should exist somewhere in the DOM under a
  // button, otherwise this test is vacuously passing.
  const glyphCount = await page.evaluate(() => {
    const targets = new Set(["−", "+"]);
    let count = 0;
    const buttons = document.querySelectorAll('[role="button"][aria-label]');
    for (const button of Array.from(buttons)) {
      for (const child of Array.from(button.querySelectorAll("*"))) {
        const ownText = Array.from(child.childNodes)
          .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (targets.has(ownText)) count++;
      }
    }
    return count;
  });
  expect(glyphCount).toBeGreaterThanOrEqual(2);
});
