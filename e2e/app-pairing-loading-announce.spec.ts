import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: clicking Connect on /pairing unmounts the form and shows
// "Processing pairing data..." with a spinner — but the loading container
// had no `role="status"`, no `aria-live`, and no `aria-busy`. Focus drops
// to <body> when the form unmounts, so screen readers received zero
// announcement that the action was in progress. WCAG 4.1.3 Status
// Messages (Level AA) requires status messages to be programmatically
// determinable without requiring the user to move focus.
//
// Fix: wrap the spinner + text in a role=status / accessibilityLiveRegion
// =polite container. Matches the ConnectionLiveRegion / InAppToast pattern.
//
// Spec strategy: feed the textarea a valid-shape pairing payload (correct
// magic + version + key lengths) so `decodePairingData` succeeds and the
// store flips to `state="pairing"`. `parsePairingForFrontend` then awaits
// sodium init + key derivation, which keeps the loading branch mounted
// long enough to inspect. The downstream pair never completes (no daemon),
// but the loading branch is what we're asserting against.
test.describe("Pairing loading state live region", () => {
  test("processing view exposes role=status for AT announcement", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    // Construct a minimal valid pairing payload entirely in the browser
    // context. Format (see packages/protocol/src/pairing.ts):
    //   magic(2) "tp" | version(1) 3 | didLen(1) N | did(N) |
    //   relayLen(1) 0 (default relay) | ps(32) | pk(32)
    // Bytes after relayLen=0: 32 + 32 = 64 random bytes (any value is
    // accepted by the decoder; key validation happens later).
    const url = await page.evaluate(() => {
      const did = "daemon-test-loading-announce";
      const didBytes = new TextEncoder().encode(did);
      const buf = new Uint8Array(2 + 1 + 1 + didBytes.length + 1 + 32 + 32);
      let o = 0;
      buf.set(new TextEncoder().encode("tp"), o);
      o += 2;
      buf[o++] = 3; // version
      buf[o++] = didBytes.length;
      buf.set(didBytes, o);
      o += didBytes.length;
      buf[o++] = 0; // relayLen=0 → default relay
      // ps + pk: zero bytes are fine for the decoder; ECDH will fail
      // downstream but that happens after the "pairing" state commits.
      o += 64;
      // base64url encode
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const b64 = btoa(bin)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return `tp://p?d=${b64}`;
    });

    // Set up a MutationObserver to capture the loading container the
    // moment it mounts. The pairing flow proceeds via sodium init +
    // key derive then either auto-completes or fails, so the role=status
    // node is only in the DOM for a brief window — observing the
    // initial mount is more reliable than polling.
    const capturePromise = page.evaluate(() => {
      return new Promise<{ role: string | null; testId: string | null }>(
        (resolve) => {
          const check = () => {
            const el = document.querySelector(
              '[data-testid="pairing-loading-status"]',
            );
            if (el) {
              resolve({
                role: el.getAttribute("role"),
                testId: el.getAttribute("data-testid"),
              });
              return true;
            }
            return false;
          };
          if (check()) return;
          const obs = new MutationObserver(() => {
            if (check()) obs.disconnect();
          });
          obs.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            obs.disconnect();
            resolve({ role: null, testId: null });
          }, 10_000);
        },
      );
    });

    // Fill the textarea and submit. The Connect button triggers
    // processScan which sets state="pairing" synchronously before
    // awaiting parsePairingForFrontend (sodium init + key derive).
    const textarea = page.locator("textarea");
    await textarea.fill(url);
    await page.getByRole("button", { name: /Connect|Confirm pairing/ }).click();

    const captured = await capturePromise;
    expect(captured.testId).toBe("pairing-loading-status");
    expect(captured.role).toBe("status");
  });
});
