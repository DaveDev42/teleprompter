import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: RenamePairingModal's TextInput exposed only its
// accessibleLabel ("Pairing label for <daemonId>"). The visible helper
// text directly below ("Empty value clears the label and falls back to
// the daemon ID.") was not wired to the input via aria-description /
// aria-describedby — so a screen reader user could land on the focused
// input, hear only "Pairing label for …", clear the value, and save
// without ever learning what an empty value means. Matches the same
// failure mode ApiKeyModal already mitigates via an imperative
// setAttribute escape hatch (RN Web's createDOMProps doesn't whitelist
// aria-description and silently drops accessibilityHint on web).
test.describe("RenamePairingModal input aria-description", () => {
  test("rename input announces the empty-value hint via aria-description", async ({
    page,
  }) => {
    // Seed a single pairing so /daemons renders a card with a Rename
    // button. Same fixture style as app-rename-modal-tab-reachable.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-rename-aria-description-deadbeef",
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

    await page.getByRole("button", { name: "Rename Test Daemon" }).click();

    const input = page.getByRole("textbox", {
      name: /Pairing label for test-rename-aria-description-deadbeef/,
    });
    await expect(input).toBeVisible({ timeout: 5_000 });

    // The imperative setAttribute fires inside a useEffect on visible
    // flip — assert the eventual attribute, not the initial render
    // (Playwright auto-retries `toHaveAttribute`).
    await expect(input).toHaveAttribute(
      "aria-description",
      "Empty value clears the label and falls back to the daemon ID",
    );
  });
});
