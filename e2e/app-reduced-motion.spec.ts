import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// WCAG 2.1 SC 2.3.3: when the user has `prefers-reduced-motion: reduce`,
// the app must drop transitions/animations to near-zero so motion-
// sensitive users aren't subjected to unsolicited movement. global.css
// previously had no such media query, so Tailwind's `transition`
// utilities would still take effect. We force the emulation via
// page.emulateMedia rather than test.use({ reducedMotion }) because
// the latter doesn't propagate to window.matchMedia in this Playwright
// version (verified empirically).
test.describe("prefers-reduced-motion is honored", () => {
  test("transition-duration is near-zero under prefers-reduced-motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Pick any element on the page and force a transition declaration on
    // it via inline style, then read the computed transition-duration.
    // If the @media (prefers-reduced-motion: reduce) override is in
    // effect, the duration should be clamped to ~0ms regardless of what
    // the inline rule said.
    const probeDuration = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.transition = "opacity 500ms ease";
      document.body.appendChild(el);
      const d = getComputedStyle(el).transitionDuration;
      el.remove();
      return d;
    });

    // The override sets transition-duration to 0.01ms. The browser
    // normalizes this to "0.00001s" or similar; just assert it's not
    // the original 500ms.
    expect(probeDuration).not.toBe("0.5s");
    expect(probeDuration).not.toBe("500ms");
  });
});
