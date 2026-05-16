import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the pairing screen renders an inline validation hint
// below the textarea when the input is non-empty but undecodable,
// but the textarea was not wired to that hint via aria-describedby.
// A screen reader user on the focused textarea would never hear the
// hint — they'd only learn the input was invalid after pressing
// Connect and getting the after-the-fact error region.
test.describe("Pairing textarea aria-describedby", () => {
  test("no aria-describedby when input is empty (no hint, no error)", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    expect(await textarea.getAttribute("aria-describedby")).toBeNull();
  });

  test("aria-describedby points at the inline hint when input is un-parseable", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.fill("not a pairing url");

    // The hint must be in the DOM (visible).
    const hint = page.getByTestId("pairing-input-hint");
    await expect(hint).toBeVisible();

    // The textarea announces its description by referencing that hint
    // id, and the referenced node must actually exist.
    expect(await textarea.getAttribute("aria-describedby")).toBe(
      "pairing-input-hint",
    );
    const targetExists = await page.evaluate(
      () => !!document.getElementById("pairing-input-hint"),
    );
    expect(targetExists).toBe(true);
  });

  test("aria-describedby cleared once input decodes (hint hidden)", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const textarea = page.getByRole("textbox", { name: /pairing data/i });
    await textarea.fill("garbage");
    expect(await textarea.getAttribute("aria-describedby")).toBe(
      "pairing-input-hint",
    );

    // Empty input → hint disappears → describedby goes away.
    await textarea.fill("");
    await expect(page.getByTestId("pairing-input-hint")).toHaveCount(0);
    expect(await textarea.getAttribute("aria-describedby")).toBeNull();
  });
});
