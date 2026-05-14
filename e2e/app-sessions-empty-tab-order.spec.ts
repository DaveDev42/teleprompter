import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: react-navigation renders the bottom tab bar after the active
// scene in DOM order, so the Sessions empty-state CTA ("Go to Daemons") used
// to capture Tab 1, ahead of the persistent navigation. Keyboard users got
// the wrong first stop. Fix: the CTA is now tabIndex=-1 — clickable for
// mouse/touch but skipped by Tab. Instructional text + the tab bar carry
// the keyboard workflow.
test.describe("Sessions empty-state CTA tab order", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("tp_")) localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    });
  });

  test("Go to Daemons CTA is not in keyboard tab order", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const cta = page.getByRole("button", { name: "Go to Daemons" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("tabindex", "-1");
  });
});
