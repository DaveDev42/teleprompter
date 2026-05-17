import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `SettingsRow` in `apps/app/app/(tabs)/settings.tsx`
// renders a trailing `›` chevron Text inside the row's Pressable to
// signal "tappable" to sighted users. The Pressable carries
// `accessibilityLabel` (→ `aria-label` on web), which per ARIA spec
// replaces the accessible name computation — but `role=button` is NOT
// atomic for virtual-cursor navigation in NVDA / JAWS browse mode.
// A virtual cursor can descend into the child Text and announce the
// `›` (U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK) as "right
// pointing angle bracket" / "›" after every Settings row readout,
// polluting the announcement.
//
// WCAG 1.1.1 (Non-text Content, Level A): decorative non-text must be
// skippable. The fix is `aria-hidden=true` on the chevron Text gated
// to web only. Native AT (VoiceOver/TalkBack) focuses the parent
// Pressable and reads accessibilityLabel without descending.
//
// The Settings tab renders without any daemon state, so all
// SettingsRow chevrons are visible in CI. DOM-level invariant:
// scan every `[role="button"][aria-label]` on /settings for a
// descendant whose textContent is `›` and assert it is hidden from AT
// (either directly via `aria-hidden="true"` or via an ancestor inside
// the button).
test("SettingsRow chevron carries aria-hidden on web", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  const leaks = await page.evaluate(() => {
    const found: Array<{ parentLabel: string; ariaHidden: string | null }> = [];
    const buttons = document.querySelectorAll('[role="button"][aria-label]');
    for (const button of Array.from(buttons)) {
      for (const child of Array.from(button.querySelectorAll("*"))) {
        // Only flag the leaf element whose own text is "›" — wrapper
        // <View>s that happen to contain a chevron descendant have the
        // same textContent but are not the AT-visible element.
        const ownText = Array.from(child.childNodes)
          .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (ownText !== "›") continue;
        // Check the child and its ancestors up to the button for
        // aria-hidden="true".
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
            ariaHidden: child.getAttribute("aria-hidden"),
          });
        }
      }
    }
    return found;
  });

  // The Settings tab is expected to render at least one row with a
  // chevron (e.g. "Theme, System") — assert non-empty as a sanity
  // check, then assert every chevron is properly hidden.
  expect(leaks).toEqual([]);

  // Sanity: at least one chevron should exist in the DOM under a
  // button, otherwise this test is vacuously passing.
  const chevronCount = await page.evaluate(() => {
    let count = 0;
    const buttons = document.querySelectorAll('[role="button"][aria-label]');
    for (const button of Array.from(buttons)) {
      for (const child of Array.from(button.querySelectorAll("*"))) {
        const ownText = Array.from(child.childNodes)
          .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (ownText === "›") count++;
      }
    }
    return count;
  });
  expect(chevronCount).toBeGreaterThan(0);
});
