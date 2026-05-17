import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the Sessions tab in
// `apps/app/app/(tabs)/index.tsx` wraps its search TextInput in a
// plain `<View>` with no `role="search"` landmark. AT users using
// landmark navigation (NVDA D, JAWS Q, VoiceOver landmarks rotor)
// can't jump to the search facility — they have to Tab through the
// page header and every preceding session row to reach the filter.
//
// Fix: spread `role="search"` on web on the wrapping `<View>` (RN's
// AccessibilityRole union excludes "search", so the raw ARIA
// attribute is the bridge). Native AT has no search-landmark
// navigation, so the change is web-only.
//
// WAI-ARIA 1.2 §5.3.27 (search role).
// WCAG 2.4.1 Bypass Blocks (Level A).
// APG Landmark Regions: "If a page includes a search facility, it
// should be contained within a search landmark."
test.describe("Sessions search wrapper exposes role=search landmark on web", () => {
  test("(tabs)/index.tsx wraps search input in role=search on web", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/app/(tabs)/index.tsx"),
      "utf8",
    );

    // Locate the search block conditional and grab the surrounding
    // markup. The block is fenced by the `{sessions.length > 2 && (`
    // condition and its closing `)}` — slice out the JSX inside.
    const guardIdx = source.indexOf("sessions.length > 2");
    expect(guardIdx).toBeGreaterThan(0);
    const searchInputIdx = source.indexOf('testID="session-search"');
    expect(searchInputIdx).toBeGreaterThan(guardIdx);

    // Take the slice from the guard to the search input — the
    // wrapping <View> must appear here with role="search" on web.
    const slice = source.slice(guardIdx, searchInputIdx);

    // Strip comment lines.
    const nonCommentLines = slice.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const code = nonCommentLines.join("\n");

    expect(code).toMatch(/role:\s*["']search["']|role=["']search["']/);
  });

  // Defense in depth: if the search input renders at runtime, its
  // wrapper must carry role=search. chat-store can't be seeded from
  // Playwright (in-memory) and sessions come from daemon, so this is
  // vacuously true today (empty Sessions tab hides the search input)
  // — but blocks any future regression that ships a >2-session DOM.
  test("any rendered session-search wrapper carries role=search on web", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const offenders = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="session-search"]');
      if (!input) return [];
      const wrapper = input.parentElement;
      if (!wrapper) return [{ reason: "no parent" }];
      const role = wrapper.getAttribute("role");
      if (role !== "search") return [{ role }];
      return [];
    });

    expect(offenders).toEqual([]);
  });
});
