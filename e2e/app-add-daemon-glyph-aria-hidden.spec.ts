import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the daemons header "Add daemon" button renders a
// `<Text>+</Text>` glyph as its only visible child. The parent
// Pressable has accessibilityLabel="Add daemon" which sets aria-label
// on the rendered <button>, but role="button" is NOT aria-atomic for
// NVDA Browse / JAWS Reading Cursor traversal — the virtual cursor
// descends into the children and re-announces the literal "+" as
// "plus" alongside (or after) the button's accessible name. The
// visible glyph is decorative because the accessible name already
// conveys the action.
//
// WCAG 1.1.1 Non-text Content (Level A) — decorative duplicates of
// content already conveyed by the button's accessible name must be
// hidden from AT. ARIA 1.2 §4.3.7: role=button is not aria-atomic.
//
// Same class of fix already applied to the session back glyph
// (`app-session-back-glyph-aria-hidden.spec.ts`) and the chat send
// arrow (`app-chat-send-glyph-aria-hidden.spec.ts`).

test.describe("Add daemon button glyph aria-hidden", () => {
  test("+ glyph inside Add daemon button is aria-hidden on web", async ({
    page,
  }) => {
    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const ariaHidden = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Add daemon"]');
      if (!btn) return "MISSING_BUTTON";
      // The Pressable renders Text as a child <div>. Walk descendants
      // until we find the one whose textContent is exactly "+".
      const all = btn.querySelectorAll("*");
      for (const el of Array.from(all)) {
        if (el.textContent?.trim() === "+") {
          return el.getAttribute("aria-hidden");
        }
      }
      return "MISSING_GLYPH";
    });

    expect(ariaHidden).toBe("true");
  });
});
