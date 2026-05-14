import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RenamePairingModal's Save button used RN's `disabled` prop,
// which RN Web translates to the native HTML `disabled` attribute. That
// strips the button from the Tab order, so when the modal opens with the
// initial label unchanged (the common case), keyboard users cannot
// discover the Save button at all — it never receives focus. The fix
// mirrors ApiKeyModal: keep the Pressable focusable and announce inert
// state via `aria-disabled` instead, so the button stays in the Tab
// sequence and the screen reader announces why it's not actionable.
test.describe("RenamePairingModal Save button keyboard reachability", () => {
  test("Save stays focusable with aria-disabled when label unchanged", async ({
    page,
  }) => {
    // Seed a pairing so the daemons screen has a card to rename.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-rename-modal-tab-1234abcd",
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

    // Open the rename modal.
    await page.getByRole("button", { name: "Rename Test Daemon" }).click();
    const save = page.getByRole("button", { name: "Save pairing label" });
    await expect(save).toBeVisible({ timeout: 5_000 });

    // The Save button must be in the Tab order (focusable) and announce
    // disabled state via aria-disabled — not be removed by `disabled`.
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(save).not.toHaveAttribute("disabled", "");

    // Verify it can actually receive focus. focus() on a `disabled`
    // button is a no-op in browsers; if the bug is back this fails.
    await save.focus();
    await expect(save).toBeFocused();
  });

  test("Save loses aria-disabled once the label changes", async ({ page }) => {
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-rename-modal-tab-5678efab",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-fixture",
          registrationProof: "proof-fixture",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-fixture",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "Test Daemon 2",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Rename Test Daemon 2" }).click();

    const input = page.getByRole("textbox", {
      name: /Pairing label for/,
    });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("Renamed Daemon");

    const save = page.getByRole("button", { name: "Save pairing label" });
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
  });
});
