import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the polite live region that mirrors the cycled theme
// label ("Theme: Dark" / "Theme: Light" / "Theme: System") had
// `role="status"` + `aria-live="polite"` but no `aria-atomic`.
// ARIA 1.2 says role=status implies atomic=true, but NVDA and some
// JAWS builds only announce the diff between updates — so cycling
// "Theme: System" → "Theme: Dark" speaks only "Dark", losing the
// "Theme:" prefix and leaving the user without context.
//
// Same fix InAppToast, ConnectionLiveRegion, and the session-stopped
// banner already adopted: set `aria-atomic="true"` imperatively
// because RN Web 0.21 silently drops the prop-level attribute.
test("theme-announcement live region carries aria-atomic=true on web", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  const region = page.getByTestId("theme-announcement");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toHaveAttribute("aria-atomic", "true");
});
