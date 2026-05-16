import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: clicking "Run Self-Test" in the Diagnostics panel updates
// the "Sodium Init / Key Gen / Encrypt/Decrypt" rows from "—" to
// "OK (Xms)" but no ancestor of those rows carries `aria-live` or
// `role="status"`, so a screen reader user pressed Enter and heard
// silence — they had to manually re-traverse every row to learn the
// outcome. Mirror the self-test result into a polite SR-only live
// region so AT speaks "Self-test complete. Sodium Init: OK. Key Gen:
// OK. Encrypt/Decrypt: OK".
test.describe("Diagnostics Self-Test announcement", () => {
  test("live region exists, is polite, and starts empty", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();
    await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible({
      timeout: 5_000,
    });

    const region = page.getByTestId("crypto-selftest-announcement");
    await expect(region).toHaveAttribute("aria-live", "polite");
    // Initial open must NOT announce anything — the user hasn't asked
    // for a self-test yet.
    expect((await region.textContent())?.trim() ?? "").toBe("");
  });

  test("Run Self-Test populates the live region with the result summary", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByRole("button", { name: /^Diagnostics/ });
    await trigger.click();
    await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible({
      timeout: 5_000,
    });

    const region = page.getByTestId("crypto-selftest-announcement");
    const run = page.getByRole("button", { name: /^Run crypto self-test$/ });
    await run.click();

    // After completion the region carries a one-line summary. Whatever
    // the platform/result, it must start with "Self-test complete." and
    // include the three subtest verdicts. The test runs against the web
    // build which has libsodium WASM available, so OK is the expected
    // path; we still accept FAIL so the spec doesn't flake on platforms
    // where the WASM init slips.
    await expect(region).toHaveText(
      /^Self-test complete\. Sodium Init: (OK|FAIL)\. Key Gen: (OK|FAIL)\. Encrypt\/Decrypt: (OK|FAIL)$/,
      { timeout: 10_000 },
    );
  });
});
