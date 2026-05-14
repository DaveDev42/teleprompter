import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: DaemonCard's outer View exposed `accessibilityLabel` without
// any `accessibilityRole`. On web, RN Web emits the label as `aria-label`
// on a generic <div> (role=null), and per the ARIA spec NVDA/JAWS ignore
// `aria-label` on roleless generics — the card's "Daemon X, connected,
// N sessions" name silently dropped on the floor for screen-reader users.
// The fix gives the card `accessibilityRole="group"` so the accessible
// name actually surfaces.
test.describe("DaemonCard accessibility", () => {
  test("rendered daemon cards expose role=group with an aria-label", async ({
    page,
  }) => {
    // Seed the pairing store. The deserializer (pairing-store.ts) only
    // base64-decodes the key fields — it does not validate sizes — so we
    // can produce a renderable PairingInfo without running real crypto.
    await page.addInitScript(() => {
      const dummy = "AAAA"; // base64 — decodes to 3 zero bytes
      const entries = [
        {
          daemonId: "test-daemon-card-a11y-1234abcd",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-fixture",
          registrationProof: "proof-fixture",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-fixture",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "QA Test Daemon",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const card = page.getByTestId("daemon-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Role must be present — without it, the aria-label is silently dropped
    // by NVDA/JAWS on a generic <div>.
    await expect(card).toHaveAttribute("role", "group");

    // And the aria-label must include the daemon's display name + status.
    const label = await card.getAttribute("aria-label");
    expect(label).toContain("Daemon QA Test Daemon");
    expect(label).toMatch(/offline|connected/);
    expect(label).toContain("sessions");
  });
});
