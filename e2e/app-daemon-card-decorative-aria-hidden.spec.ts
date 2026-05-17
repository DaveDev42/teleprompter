import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: DaemonCard's `role="group"` wrapper carries an
// accessibilityLabel like `${name}, connected, 0 sessions`. But
// role=group is NOT aria-atomic for NVDA Browse / JAWS Reading
// Cursor — virtual cursor descends into the card and visits two
// decorative children whose content is already encoded in the
// wrapper's accessible name:
//
//   1. A `<View>` color dot ("running"/"stopped" indicator) at the
//      start of the header row — empty <div> that NVDA announces as
//      a content-less pause.
//   2. A `<Text>` rendering "Connected" / "Last seen Xm ago" at the
//      far right of the header row — duplicates the "connected" /
//      "offline" fragment already in the group label.
//
// Both must carry `aria-hidden="true"` on web. Native AT focuses the
// wrapper and reads accessibilityLabel directly.
//
// WCAG 1.1.1 Non-text Content (Level A), WCAG 1.3.1 Info and
// Relationships (Level A); ARIA 1.2 §4.3.7 (role=group is not
// aria-atomic). Same class of fix as `SessionRow` (covered by
// `app-session-row-status-dot-aria-hidden.spec.ts`), but the
// `DaemonCard` parallel was missed.

test.describe("DaemonCard decorative children aria-hidden", () => {
  test("status dot and status text both carry aria-hidden on web", async ({
    page,
  }) => {
    // Seed a paired daemon so DaemonCard actually renders. The
    // pairing-store deserializer base64-decodes only — it does not
    // validate sizes — so a fixture pairing works without real crypto.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-bug-117-daemon-card-decorative-aria",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-fixture",
          registrationProof: "proof-fixture",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-fixture",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "BUG-117 Daemon",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    const card = page.getByTestId("daemon-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Inspect the card's DOM in-page so we can find the specific decorative
    // children by their structural signatures.
    const result = await card.evaluate((root) => {
      // The status dot is the first descendant with `rounded-full` and
      // the small size used by the indicator (w-2.5 h-2.5). RN Web emits
      // those Tailwind classes verbatim, so a className substring match
      // is reliable.
      const dot = Array.from(root.querySelectorAll("div")).find((el) =>
        /rounded-full/.test(el.className) &&
        /w-2\.5/.test(el.className) &&
        /h-2\.5/.test(el.className),
      );
      // The status text node renders either "Connected" or "Last seen ..."
      const statusText = Array.from(root.querySelectorAll("div")).find(
        (el) => {
          const txt = el.textContent?.trim() ?? "";
          return /^(Connected|Last seen .+)$/.test(txt);
        },
      );
      return {
        dotAriaHidden: dot?.getAttribute("aria-hidden") ?? null,
        dotFound: !!dot,
        statusTextAriaHidden: statusText?.getAttribute("aria-hidden") ?? null,
        statusTextFound: !!statusText,
        statusTextContent: statusText?.textContent?.trim() ?? null,
      };
    });

    expect(result.dotFound, "status dot <div> found in DaemonCard").toBe(true);
    expect(result.dotAriaHidden, "status dot aria-hidden").toBe("true");

    expect(
      result.statusTextFound,
      "status text node found in DaemonCard",
    ).toBe(true);
    expect(result.statusTextAriaHidden, "status text aria-hidden").toBe(
      "true",
    );
  });
});
