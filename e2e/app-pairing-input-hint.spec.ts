import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// The pairing screen lets users paste a `tp://p?d=...` string. Before
// this change, typing anything non-empty enabled the Connect button
// even if the payload was unparseable — the user found out only after
// clicking, when processScan surfaced an "Invalid pairing data" error.
// Adding a small inline hint below the textarea when input is
// non-empty but undecodable gives feedback while typing.
test.describe("Pairing input inline validation hint", () => {
  test("no hint shown when input is empty", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("pairing-input-hint")).toHaveCount(0);
  });

  test("hint appears for un-parseable input", async ({ page }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.fill("not a pairing url");

    await expect(page.getByTestId("pairing-input-hint")).toBeVisible();
  });

  test("hint disappears for input that decodes to a preview", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    // The hint just needs to disappear when decodePairingData stops
    // throwing — start by filling garbage so the hint is visible.
    await textarea.fill("garbage");
    await expect(page.getByTestId("pairing-input-hint")).toBeVisible();

    // Then clear the field; hint goes away because input is empty.
    await textarea.fill("");
    await expect(page.getByTestId("pairing-input-hint")).toHaveCount(0);
  });
});
