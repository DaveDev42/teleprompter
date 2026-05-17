import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RenamePairingModal exposed an accessible name ("Rename
// Daemon") via aria-label but not the helper text via aria-describedby.
// Per the WAI-ARIA APG Dialog Pattern §3.2.2 + WCAG 4.1.2 (Name, Role,
// Value, Level A), the helper text "Empty value clears the label and
// falls back to the daemon ID." must be wired to the dialog's accessible
// description so screen readers announce it on dialog entry — not only
// when the user Tabs onto the input. ConfirmUnpairModal already received
// the same fix (see app-confirm-unpair-describedby.spec.ts); the sister
// modal was missed in that pass.
//
// Fix attaches a stable id to the helper Text via `nativeID` (RN Web
// maps it to DOM `id`) and threads it through ModalContainer's
// `accessibilityDescribedBy` prop, which spreads `aria-describedby` on
// the RN Web <Modal> root.
test.describe("RenamePairingModal aria-describedby", () => {
  test("dialog announces its helper text via aria-describedby", async ({
    page,
  }) => {
    // Seed a single pairing so /daemons renders a card with a Rename
    // button — same fixture pattern as the sibling rename modal specs.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-rename-modal-describedby-9999cafe",
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

    // RN Web's <Modal> hardcodes role="dialog" + aria-modal="true" on
    // the outer wrapper; anchor on the accessible name.
    const dialog = page.getByRole("dialog", { name: "Rename Daemon" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const describedBy = await dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    // Referenced node must exist — ARIA description computation only
    // consumes the relationship if the target resolves.
    const descId = describedBy ?? "";
    const descNode = page.locator(`#${descId}`);
    await expect(descNode).toBeAttached();

    // And its text must be the helper copy. Assert the durable portion
    // so the spec survives minor copy edits.
    const text = (await descNode.textContent()) ?? "";
    expect(text.toLowerCase()).toContain("clears the label");
    expect(text.toLowerCase()).toContain("daemon id");
  });
});
