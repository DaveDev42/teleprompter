import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Diagnostics screen title was a plain Text without
// role=heading, while DiagnosticsPanel rendered its own H2 "Diagnostics"
// underneath. Screen readers saw H2 → H3 with no H1, and the same
// "Diagnostics" string appeared twice (once as a non-heading div, once
// as an H2). Fix lifts the screen title to H1 and removes the duplicate
// H2 from DiagnosticsPanel so the hierarchy is H1 → H2 (CONNECTION /
// SESSIONS) → H3 (Section subheadings).
test.describe("Diagnostics screen heading hierarchy", () => {
  test("screen title is the only H1 'Diagnostics' on the page", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Diagnostics" }).click();

    const h1 = page.getByRole("heading", { level: 1, name: "Diagnostics" });
    await expect(h1).toHaveCount(1);

    // No H2 should also say "Diagnostics" — that would be the duplicate
    // the fix removed.
    const h2Diag = page.getByRole("heading", {
      level: 2,
      name: "Diagnostics",
    });
    await expect(h2Diag).toHaveCount(0);
  });

  test("section labels (CONNECTION, SESSIONS) are H2", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Diagnostics" }).click();

    await expect(
      page.getByRole("heading", { level: 2, name: "CONNECTION" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { level: 2, name: /^SESSIONS/ }),
    ).toHaveCount(1);
  });
});
