import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: both polite live regions inside the Diagnostics panel
// (RTT ping result + crypto self-test summary) had `role="status"` +
// `aria-live="polite"` but no `aria-atomic`. ARIA 1.2 says role=status
// implies atomic=true, but NVDA + some JAWS builds only announce the
// diff between updates — so updating "RTT: 12ms" → "RTT: 18ms" speaks
// only "18ms" (no prefix) and the 40-word self-test summary gets
// fragmented to a single changed token.
//
// Same fix InAppToast, ConnectionLiveRegion, theme-announcement, and
// the session-stopped banner already adopted: emit `aria-atomic="true"`
// imperatively because RN Web 0.21 drops the prop-level attribute on
// <View>.
test("diagnostics live regions carry aria-atomic=true on web", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.getByRole("button", { name: "Done" }).waitFor({ timeout: 5_000 });

  await expect(page.getByTestId("rtt-announcement")).toHaveAttribute(
    "aria-atomic",
    "true",
  );
  await expect(
    page.getByTestId("crypto-selftest-announcement"),
  ).toHaveAttribute("aria-atomic", "true");
});
