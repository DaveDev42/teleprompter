import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session header container has `role="group"` with a
// composed `aria-label` ("Session foo, running"), but `role=group` is
// NOT atomic for NVDA/JAWS virtual-cursor navigation. The cursor
// descends into children and re-announces the visible <Text>foo</Text>
// node after already announcing the group's aria-label, doubling the
// session name. The running-state green dot (a bare decorative <View>)
// is also surfaced when present.
//
// Both decorative children must carry `aria-hidden="true"` on web so
// the wrapper's aria-label is the single source of truth.
//
// WCAG 1.1.1 Non-text Content (Level A) — decorative duplicates of
// content already encoded in the parent's accessible name must be
// hidden from AT. ARIA 1.2 §6.3.12: role=group does not imply
// aria-atomic, so AT descends into children.
//
// Closest existing spec is `app-session-header-role.spec.ts`, which
// only verifies that the wrapper has role=group + aria-label; it does
// NOT assert that the children inside the group carry aria-hidden.

test.describe("Session header decorative children aria-hidden", () => {
  test("session title text child carries aria-hidden on web", async ({
    page,
  }) => {
    await page.goto("/session/decorative-hidden-check");
    await page.waitForLoadState("networkidle");

    const header = page.locator('[role="group"][aria-label^="Session "]');
    await expect(header).toBeVisible();

    // The visible title <Text> renders as a child <div> containing the
    // session name string. It must be aria-hidden so virtual cursor
    // tools don't double-announce the name already in the group label.
    const titleChild = header
      .locator("div", { hasText: "decorative-hidden-check" })
      .first();
    await expect(titleChild).toHaveAttribute("aria-hidden", "true");
  });
});
