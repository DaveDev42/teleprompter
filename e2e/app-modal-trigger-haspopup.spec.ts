import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Settings rows that open modal dialogs (Chat Font,
// Code Font, Terminal Font, Font Size, OpenAI API Key) and the
// DaemonCard Rename / Unpair buttons all triggered FontPickerModal /
// FontSizeModal / ApiKeyModal / RenamePairingModal / ConfirmUnpairModal
// — proper ARIA dialogs — but had no `aria-haspopup="dialog"` on the
// triggering button. WAI-ARIA §6.6 (Dialog) says a control that
// opens a dialog should advertise that via `aria-haspopup="dialog"`
// so the screen reader announces "<label>, button, has popup dialog"
// before the user activates it. Without it the user pressing Enter
// gets the dialog open with no prior cue — the popup transition is
// invisible to AT users.
//
// RN Web's accessibility prop bridge doesn't translate any
// `accessibilityHasPopup` equivalent so the fix spreads the raw
// `aria-haspopup` attribute on web only via a Platform.OS gated
// props bag (mirroring the `aria-selected`/`aria-controls` pattern
// already used on session tablist).
test.describe("Modal trigger buttons advertise aria-haspopup", () => {
  test("Settings modal-opening rows expose aria-haspopup='dialog'", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Each row's aria-label is `<label>, <value>` (e.g. "Chat Font,
    // Inter"). Match by prefix.
    const expectHasPopup = async (prefix: string) => {
      const btn = page.locator(`[aria-label^="${prefix}"]`).first();
      await expect(btn).toBeVisible();
      await expect(btn).toHaveAttribute("aria-haspopup", "dialog");
    };

    await expectHasPopup("Chat Font");
    await expectHasPopup("Code Font");
    await expectHasPopup("Terminal Font");
    await expectHasPopup("Font Size");
    await expectHasPopup("OpenAI API Key");
  });

  test("Daemon card Rename and Unpair buttons expose aria-haspopup='dialog'", async ({
    page,
  }) => {
    // Seed a single pairing — same fixture style as
    // app-rename-modal-tab-reachable.spec.ts / etc.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-haspopup-daemon-deadbeef",
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

    const rename = page.getByRole("button", { name: "Rename Test Daemon" });
    await expect(rename).toBeVisible({ timeout: 5_000 });
    await expect(rename).toHaveAttribute("aria-haspopup", "dialog");

    const unpair = page
      .getByRole("button", { name: "Remove pairing with Test Daemon" })
      .first();
    await expect(unpair).toBeVisible();
    await expect(unpair).toHaveAttribute("aria-haspopup", "dialog");
  });
});
