import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session header title container had `aria-label`
// ("Session foo, running") but no `role`. ARIA spec: aria-label on a
// role=generic element (the default for a bare <div>) is silently
// ignored by AT — a screen reader user pressed into the session view
// and never heard the session name or running state.
//
// Fix is `role="group"` so the wrapper has a meaningful role and the
// composed label is actually spoken when focus enters the header.
test.describe("Session header role", () => {
  test("session title container has role=group with aria-label", async ({
    page,
  }) => {
    await page.goto("/session/test-header-role");
    await page.waitForLoadState("networkidle");

    // The header title container is the unique role=group element
    // whose aria-label starts with "Session ".
    const header = page.locator('[role="group"][aria-label^="Session "]');
    await expect(header).toBeVisible();

    // aria-label must include the session name (URL slug).
    const label = await header.getAttribute("aria-label");
    expect(label).toMatch(/^Session test-header-role/);
  });
});
