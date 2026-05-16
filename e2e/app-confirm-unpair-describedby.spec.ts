import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: ConfirmUnpairModal exposed an accessible name ("Remove
// Daemon") via aria-label but not the warning body text via
// aria-describedby. Per the WAI-ARIA APG Dialog Pattern (and especially
// for destructive confirmation dialogs), the body must be wired to the
// dialog's accessible description — otherwise the screen reader
// announces only the name when the dialog opens and the consequences
// of pressing the focused "Remove" button ("You'll need to scan a new
// QR code from the daemon to reconnect.") are completely silent. The
// keyboard user can activate Remove without ever hearing the warning.
//
// The fix attaches a stable id to the body Text via `nativeID` (RN Web
// maps that to a DOM `id`) and threads it through ModalContainer's new
// `accessibilityDescribedBy` prop, which spreads `aria-describedby` on
// the RN Web <Modal> root (RN Web's createDOMProps doesn't translate
// `accessibilityDescribedBy` on a <Modal>, so we use a raw aria attr).
test.describe("ConfirmUnpairModal aria-describedby", () => {
  test("destructive dialog announces its warning text via aria-describedby", async ({
    page,
  }) => {
    // Seed a single pairing so /daemons renders a card with an Unpair
    // button — exactly the same fixture style as
    // app-rename-modal-tab-reachable.spec.ts.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-confirm-unpair-describedby-9999cafe",
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

    // Open the ConfirmUnpairModal. The card-row Unpair button is
    // labeled "Remove pairing with <name>" — the same accessible label
    // the modal's confirm button uses.
    await page
      .getByRole("button", { name: "Remove pairing with Test Daemon" })
      .first()
      .click();

    // The dialog itself: RN Web's <Modal> hardcodes role="dialog" +
    // aria-modal="true" on the outer wrapper, so we anchor to that.
    const dialog = page.getByRole("dialog", { name: "Remove Daemon" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // aria-describedby must point at a present element whose text is
    // the warning body. Without this, screen readers announce only the
    // dialog name on focus entry and the user never hears about the
    // QR-code consequence.
    const describedBy = await dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    // The referenced node must actually exist in the DOM. ARIA name
    // computation only consumes the relationship if the target resolves.
    const descId = describedBy ?? "";
    const descNode = page.locator(`#${descId}`);
    await expect(descNode).toBeAttached();

    // And its text must be the warning body — the consequence text.
    // We assert the durable portion ("scan a new QR code") so the spec
    // survives minor copy changes around the daemon name.
    const text = (await descNode.textContent()) ?? "";
    expect(text.toLowerCase()).toContain("scan a new qr code");
  });
});
