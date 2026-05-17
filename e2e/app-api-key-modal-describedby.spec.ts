import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

async function openApiKeyModal(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (
      Array.from(document.querySelectorAll("[aria-label]")).find((el) =>
        el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
      ) as HTMLElement | undefined
    )?.click();
  });
}

// Regression: ApiKeyModal opens with a static helper paragraph ("Required
// for voice input. Your key is stored locally on this device.") but the
// dialog wrapper carried no `aria-describedby`. APG Dialog Pattern §3.2.2
// requires `aria-describedby` to attach a static description to the
// dialog so AT users hear the context, not just the dialog's name.
// Sibling modals (ConfirmUnpairModal, RenamePairingModal) already wire
// `accessibilityDescribedBy` through ModalContainer to the helper Text's
// `nativeID`. ApiKeyModal was the outlier.
//
// WCAG 2.1 SC 4.1.2 Name, Role, Value (Level A) requires the description
// to be programmatically determinable. APG Dialog §3.2.2.
test.describe("ApiKeyModal dialog has aria-describedby pointing at helper text", () => {
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

  test("dialog exposes aria-describedby referencing the helper paragraph", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await openApiKeyModal(page);
    const dialog = page.getByRole("dialog", { name: "OpenAI API Key" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const describedBy = await dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    // The id pointed at must resolve to a real DOM node carrying the
    // helper text — otherwise the attribute is dangling and AT
    // announces nothing.
    const descNode = page.locator(`#${describedBy}`);
    await expect(descNode).toBeAttached();
    const text = (await descNode.textContent()) ?? "";
    expect(text.toLowerCase()).toContain("voice input");
  });
});
