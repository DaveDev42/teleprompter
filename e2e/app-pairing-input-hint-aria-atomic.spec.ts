import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the inline pairing-input-hint live region carried
// `role="status"` + `aria-live="polite"` but was missing
// `aria-atomic="true"`. ARIA 1.2 §6.6.5 says `role="status"` implies
// `aria-atomic=true`, but NVDA and JAWS do not honor the implicit
// default — the attribute must be present explicitly. The hint
// sentence interleaves a `<Text className="font-mono">tp://p?d=</Text>`
// fragment with surrounding prose, so without `aria-atomic` the diff
// announcement can fragment to just the inline code instead of the
// full "Doesn't look like pairing data — should start with tp://p?d="
// sentence.
//
// Every other `role="status"` region in the app applies the attribute
// imperatively (InAppToast, ConnectionLiveRegion, VoiceButton state &
// transcript, DiagnosticsPanel, settings theme announcement, etc.)
// because RN Web 0.21's createDOMProps drops prop-level aria-atomic.
// This was the only outlier.
//
// WCAG 4.1.3 Status Messages (Level AA).
test.describe("Pairing input hint aria-atomic", () => {
  test("hint container carries aria-atomic=true on web", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.fill("not a pairing url");

    const hint = page.getByTestId("pairing-input-hint");
    await expect(hint).toBeVisible();
    // The fix attaches `aria-atomic="true"` via the same imperative
    // useEffect pattern used by every sibling status region.
    await expect(hint).toHaveAttribute("aria-atomic", "true");
  });
});
