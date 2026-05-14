import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RN Web's Pressable forwards aria-disabled only when its
// `disabled` prop is truthy (createDOMProps only emits the attribute when
// disabled === true). Until each Pressable also passed `disabled={...}`
// alongside accessibilityState.disabled, screen readers couldn't tell that
// boundary-hit buttons (font size at 10/24, etc.) were inert. Validate via
// FontSizeModal: at boundary the matching button must carry aria-disabled
// = "true"; off-boundary buttons should not have the attribute at all.
test.describe("aria-disabled web fallback", () => {
  test("FontSizeModal boundary buttons expose aria-disabled", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const fontSizeRow = page.getByText("Font Size", { exact: true }).first();
    await expect(fontSizeRow).toBeVisible();
    await fontSizeRow.click();

    const decrease = page.getByRole("button", { name: "Decrease font size" });
    const increase = page.getByRole("button", { name: "Increase font size" });
    await expect(decrease).toBeVisible();
    await expect(increase).toBeVisible();

    // Initial state: default size is 15 — neither boundary. RN Web omits
    // aria-disabled entirely when disabled is false.
    await expect(decrease).not.toHaveAttribute("aria-disabled", "true");
    await expect(increase).not.toHaveAttribute("aria-disabled", "true");

    // Drive size to 10 (atMin). Need at most 5 clicks from 15; loop with cap.
    for (let i = 0; i < 20; i++) {
      const ariaDisabled = await decrease.getAttribute("aria-disabled");
      if (ariaDisabled === "true") break;
      await decrease.click();
    }
    await expect(decrease).toHaveAttribute("aria-disabled", "true");
    await expect(increase).not.toHaveAttribute("aria-disabled", "true");

    // Drive size to 24 (atMax). 9 clicks from 15.
    for (let i = 0; i < 30; i++) {
      const ariaDisabled = await increase.getAttribute("aria-disabled");
      if (ariaDisabled === "true") break;
      await increase.click();
    }
    await expect(increase).toHaveAttribute("aria-disabled", "true");
    await expect(decrease).not.toHaveAttribute("aria-disabled", "true");
  });
});
