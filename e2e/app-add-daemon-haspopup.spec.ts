import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the "+" button in the `/daemons` header opens the
// `pairing/index` screen, which is registered with
// `presentation: "modal"` in `app/_layout.tsx` and rendered as a
// modal dialog. The trigger needs `aria-haspopup="dialog"` so AT
// announces "Add daemon, button, has popup dialog" before activation
// — the same invariant covered by `app-modal-trigger-haspopup.spec.ts`
// for Settings rows and DaemonCard Rename/Unpair buttons.
//
// Without haspopup, NVDA/VoiceOver users press Enter and the modal
// transition is invisible to them — the modal pops without any prior
// cue. WAI-ARIA 1.2 §6.6 + APG Dialog Pattern §3.2.2 require the
// trigger to advertise the popup type.
//
// RN's accessibilityState doesn't expose haspopup, so the fix spreads
// `aria-haspopup="dialog"` on web only via a `Platform.OS` gated
// props bag — same pattern as the other modal triggers.
test("Add daemon header button exposes aria-haspopup='dialog'", async ({
  page,
}) => {
  await page.goto("/daemons");
  await page.waitForLoadState("networkidle");

  const addBtn = page.getByRole("button", { name: "Add daemon" });
  await expect(addBtn).toBeVisible();
  await expect(addBtn).toHaveAttribute("aria-haspopup", "dialog");
});
