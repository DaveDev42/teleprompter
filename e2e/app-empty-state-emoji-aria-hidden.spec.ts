/**
 * BUG-68: Decorative emoji in empty-state illustrations are missing
 * `aria-hidden="true"`, so screen readers announce them as "speech
 * balloon emoji" / "desktop computer emoji" when navigating the empty
 * Sessions and Daemons pages via virtual cursor — pure noise with no
 * informational value (the adjacent headings already convey the meaning).
 *
 * WCAG 1.1.1 Non-text Content (Level A): decorative images/icons must
 * have `alt=""` or equivalent (aria-hidden="true") so AT can ignore them.
 *
 * Fix: wrap each emoji <Text> (or its icon container <View>) in
 * `aria-hidden="true"` on web.
 */
import { expect, test } from "@playwright/test";

test.describe("Empty state decorative emoji aria-hidden", () => {
  test("Sessions empty state 💬 emoji has aria-hidden on web", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForTimeout(1000);

    // The 💬 emoji is a decorative illustration — its container
    // should be hidden from the accessibility tree.
    const emojiAriaHidden = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        const text = el.textContent?.trim();
        if (text === "💬" && el.children.length === 0) {
          // Check the element itself or any of its ancestors up to 3 levels
          // for aria-hidden="true".
          let node: Element | null = el;
          for (let i = 0; i < 4; i++) {
            if (node?.getAttribute("aria-hidden") === "true") return true;
            node = node?.parentElement ?? null;
          }
          return false;
        }
      }
      return null; // emoji not found
    });

    // Should be hidden from AT (aria-hidden="true" on self or container)
    expect(emojiAriaHidden).toBe(true);
  });

  test("Daemons empty state 🖥 emoji has aria-hidden on web", async ({
    page,
  }) => {
    await page.goto("/daemons");
    await page.waitForTimeout(1000);

    const emojiAriaHidden = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        const text = el.textContent?.trim();
        if (text === "🖥" && el.children.length === 0) {
          let node: Element | null = el;
          for (let i = 0; i < 4; i++) {
            if (node?.getAttribute("aria-hidden") === "true") return true;
            node = node?.parentElement ?? null;
          }
          return false;
        }
      }
      return null; // emoji not found
    });

    expect(emojiAriaHidden).toBe(true);
  });
});
