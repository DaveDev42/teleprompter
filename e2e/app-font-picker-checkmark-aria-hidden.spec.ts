import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `FontPickerModal` renders a `✓` Text next to the
// committed font inside each `role="option"` Pressable. The option
// already conveys its committed-ness through `aria-selected` (with
// follow-focus per the APG single-select listbox pattern), so the
// glyph is purely a visual affordance for sighted users. role=option
// is traversable by virtual cursors (it isn't atomic), so without
// `aria-hidden` AT announces "Inter, option, 1 of 6, selected, check
// mark" with a trailing redundant glyph — and worse, after ArrowDown
// navigation `aria-selected` moves to the focused option while the
// glyph stays on the committed one, producing "not selected, check
// mark" which is contradictory.
//
// Native AT reads the Pressable's accessibilityLabel + selected state
// and doesn't descend into children for role=button/option, so the
// fix is web-only. WCAG 1.1.1 Non-text Content (Level A).
test.describe("FontPickerModal committed-font checkmark aria-hidden", () => {
  test("the ✓ Text inside the committed option spreads aria-hidden on web", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/FontPickerModal.tsx"),
      "utf8",
    );
    // Locate the JSX glyph (the second `✓` in the file — the first
    // occurrence lives inside the explanatory comment block above the
    // element). Walk backwards to the immediately enclosing <Text ...>
    // opening tag — the Text whose closing </Text> comes AFTER the
    // glyph. A naive lastIndexOf would match the preceding font-name
    // Text whose body closed before the glyph; require the closing
    // </Text> sit past the glyph position to pick the right element.
    const firstGlyph = source.indexOf("✓");
    const glyphIdx = source.indexOf("✓", firstGlyph + 1);
    expect(glyphIdx).toBeGreaterThan(0);
    let cursor = glyphIdx;
    let tag: string | null = null;
    while (cursor > 0) {
      const tagStart = source.lastIndexOf("<Text", cursor);
      if (tagStart < 0) break;
      const tagEnd = source.indexOf(">", tagStart);
      const closing = source.indexOf("</Text>", tagEnd);
      if (closing > glyphIdx) {
        tag = source.slice(tagStart, tagEnd);
        break;
      }
      cursor = tagStart - 1;
    }
    expect(tag).not.toBeNull();

    expect(tag).toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );
  });

  test("rendered listbox option does not expose ✓ to AT", async ({ page }) => {
    await page.goto("/(tabs)/settings");
    await page.waitForLoadState("networkidle");

    // Open the Chat Font picker. The setting row name is "Chat Font".
    const chatFontRow = page
      .getByRole("button", { name: /chat font/i })
      .first();
    await expect(chatFontRow).toBeVisible({ timeout: 5_000 });
    await chatFontRow.click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible({ timeout: 5_000 });

    // Walk options and verify any visible ✓ descendant is inside an
    // aria-hidden subtree (or absent — the picker may have no committed
    // font yet, in which case the assertion is vacuously true).
    const leaks = await page.evaluate(() => {
      const offenders: Array<{ optionLabel: string; text: string }> = [];
      const options = document.querySelectorAll('[role="option"]');
      for (const option of Array.from(options)) {
        const label = option.getAttribute("aria-label") ?? "";
        for (const node of Array.from(option.querySelectorAll("*"))) {
          if ((node.textContent ?? "").trim() !== "✓") continue;
          let cursor: Element | null = node;
          let hidden = false;
          while (cursor && cursor !== option) {
            if (cursor.getAttribute("aria-hidden") === "true") {
              hidden = true;
              break;
            }
            cursor = cursor.parentElement;
          }
          if (!hidden) offenders.push({ optionLabel: label, text: "✓" });
        }
      }
      return offenders;
    });

    expect(leaks).toEqual([]);
  });
});
