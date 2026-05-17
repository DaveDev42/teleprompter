import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the session chat container in
// `apps/app/app/session/[sid].tsx` exposes `role="log"` on web so AT
// treats it as a chat transcript landmark. `role="log"` carries an
// implicit `aria-live="polite"` per the ARIA spec, but NVDA and JAWS
// have historically (still in current versions) ignored the implicit
// aria-live on role=log and other live region roles — they only
// announce appended messages when `aria-live` is set explicitly.
//
// Every other live region in the app (InAppToast role=status,
// VoiceButton role=status, DiagnosticsPanel role=status,
// FontPickerModal aria-selected-follows-focus status region) sets
// aria-live explicitly for exactly this reason. The chat log must do
// the same or new Claude messages are silently appended and never
// announced when the user is browsing elsewhere on the page.
//
// WCAG 4.1.3 (Status Messages, Level AA): status changes must be
// programmatically announced. WCAG 1.3.1 (Info and Relationships):
// the live region semantics must reach AT.
//
// The session route renders the chat log container even when there
// is no live daemon (it shows the empty / "Connecting..." state), so
// the `[role="log"]` element is present in CI without seeded
// chat-store content. Assert its `aria-live` attribute is "polite".
test("session chat log carries explicit aria-live=polite on web", async ({
  page,
}) => {
  await page.goto("/session/test-chat-log-aria-live");
  await page.waitForLoadState("networkidle");

  const result = await page.evaluate(() => {
    const el = document.querySelector('[role="log"]');
    if (!el) return null;
    return {
      ariaLive: el.getAttribute("aria-live"),
      ariaLabel: el.getAttribute("aria-label"),
    };
  });

  expect(result).not.toBeNull();
  expect(result?.ariaLabel).toBe("Chat log");
  expect(result?.ariaLive).toBe("polite");
});
