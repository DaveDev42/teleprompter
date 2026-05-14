import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the manual-pairing screen used to be a keyboard dead-end on
// web. Tab cycled only between body and the textarea — the "Connect" button
// had no role/label/tabIndex, so screen readers couldn't see it and
// keyboard users couldn't submit. The header also lacked role=heading.
test.describe("Pairing screen accessibility", () => {
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

  test("header has role=heading", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const header = page.getByRole("heading", { name: "Pair with Daemon" });
    await expect(header).toBeVisible();
  });

  test("Connect button has role=button and aria-label", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const button = page.getByRole("button", { name: /^Connect$/ });
    await expect(button).toBeVisible();
  });

  test("pairing input has aria-label", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");
    const input = page.getByLabel("Pairing data");
    await expect(input).toBeVisible();
  });

  test("Connect button is keyboard-reachable via Tab", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    // Focus the input first via its testID, then Tab forward.
    const input = page.getByTestId("pairing-input");
    await input.focus();
    // Fill so the button is enabled.
    await input.fill("tp://p?d=invalid-but-fills-the-input");

    // Tab to next focusable; the button should be reachable within a couple of hops.
    let found = false;
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const text = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("aria-label") || el?.innerText?.trim() || "";
      });
      if (/Connect/i.test(text)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
