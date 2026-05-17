import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ModalContainer's dialogs expose `aria-label` on the dialog
// wrapper but NOT `aria-labelledby` pointing at the visible heading inside.
// Per APG Dialog Pattern §3.2.2, when a dialog contains a visible title
// element the dialog's accessible name MUST reference it via
// `aria-labelledby` so the screen reader can associate the spoken name with
// the rendered text. Using `aria-label` alone means the name is disconnected
// from the visible heading (a duplicate string that can drift on
// localisation or content changes). WCAG SC 4.1.2 requires programmatic
// association of Name, Role, Value.
//
// Fix: give the heading element a stable `id` inside each ModalContainer
// caller (FontSizeModal, FontPickerModal, ApiKeyModal, etc.) and set
// `aria-labelledby` on the dialog to that id, replacing the current
// `aria-label` duplicate.
test.describe("Modal dialogs aria-labelledby", () => {
  test("FontSizeModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Font Size modal
    await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"]'),
      );
      const row = rows.find((r) =>
        r.getAttribute("aria-label")?.startsWith("Font Size"),
      );
      row?.click();
    });

    // Wait for the dialog to appear
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The heading inside the dialog must have an id so it can be referenced
    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    // The dialog must use aria-labelledby pointing at the heading's id
    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });

  test("ApiKeyModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open API Key modal
    await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[aria-label]"),
      );
      const row = rows.find((el) =>
        el.getAttribute("aria-label")?.startsWith("OpenAI API Key"),
      );
      row?.click();
    });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });

  test("FontPickerModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open Chat Font picker — first font picker row exposed in Settings.
    await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"]'),
      );
      const row = rows.find((r) =>
        r.getAttribute("aria-label")?.startsWith("Chat Font"),
      );
      row?.click();
    });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });

  test("RenamePairingModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    // Seed a single pairing so /daemons renders a card with a Rename button.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-rename-labelledby-9999cafe",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-fixture",
          registrationProof: "proof-fixture",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-fixture",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "Test Daemon",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    await page
      .getByRole("button", { name: "Rename Test Daemon" })
      .first()
      .click();

    const dialog = page.getByRole("dialog", { name: "Rename Daemon" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });

  test("ConfirmUnpairModal dialog references visible heading via aria-labelledby", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-unpair-labelledby-9999cafe",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-fixture",
          registrationProof: "proof-fixture",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-fixture",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "Test Daemon",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    await page
      .getByRole("button", { name: "Remove pairing with Test Daemon" })
      .first()
      .click();

    const dialog = page.getByRole("dialog", { name: "Remove Daemon" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const heading = dialog.locator('[role="heading"]').first();
    await expect(heading).toBeVisible();
    const headingId = await heading.getAttribute("id");
    expect(headingId).not.toBeNull();
    expect(headingId!.length).toBeGreaterThan(0);

    await expect(dialog).toHaveAttribute("aria-labelledby", headingId!);
  });
});
