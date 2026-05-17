import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: in `apps/app/app/(tabs)/index.tsx`, the active SessionRow
// signals its "selected" state only by appending ", selected" to the
// `accessibilityLabel` string. That reads naturally for native AT but
// on web it bakes state into the accessible name where:
//   - CSS attribute selectors like [aria-current="true"] can't reach it
//   - axe-core / a11y scanners that check state attributes miss it
//   - Screen-reader state announcement (NVDA "selected, button, …")
//     fires only when the actual ARIA token is set, not when the word
//     happens to appear inside the name string
//
// RN Web's `AccessibilityState` union has no `current` field, so
// `accessibilityState={{ current: true }}` would be dropped silently.
// The only reliable bridge is a raw `aria-current` spread guarded by
// `Platform.OS === "web"`. Same pattern as aria-checked on VoiceButton,
// aria-expanded on ToolCard, aria-disabled on FontSizeModal.
//
// ARIA 1.2 §6.6.4 aria-current. WCAG 4.1.2 Name, Role, Value (Level A).
// WCAG 2.4.6 Headings and Labels (Level AA) — labels shouldn't conflate
// identity with state.
test.describe("SessionRow exposes aria-current on the active row", () => {
  test("(tabs)/index.tsx SessionRow Pressable spreads aria-current on web when active", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/app/(tabs)/index.tsx"),
      "utf8",
    );

    // Locate the SessionRow function body. It is a top-level
    // `function SessionRow(...)` declaration; slice until the next
    // top-level `function ` declaration.
    const fnStart = source.indexOf("function SessionRow");
    expect(fnStart).toBeGreaterThan(0);
    const afterFn = fnStart + "function SessionRow".length;
    // Match the next top-level function declaration of any export
    // flavor — `function`, `export function`, or `export default
    // function`. In this file SessionsScreen happens to be
    // `export default function`, which a bare `/^function /m` misses.
    const nextFnMatch = source
      .slice(afterFn)
      .match(/^(?:export\s+(?:default\s+)?)?function /m);
    expect(nextFnMatch).not.toBeNull();
    const fnEnd = afterFn + (nextFnMatch?.index ?? 0);
    const fnBody = source.slice(fnStart, fnEnd);

    // Strip comment lines so documentation can't satisfy the invariant.
    const nonCommentLines = fnBody.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const body = nonCommentLines.join("\n");

    // Must spread aria-current on web when isActive. Match the
    // established pattern: a Platform.OS === "web" guard combined with
    // an aria-current literal that is keyed off isActive.
    expect(body).toMatch(
      /Platform\.OS\s*===\s*["']web["']\s*&&\s*isActive[\s\S]*?["']aria-current["']\s*:\s*["']true["']/,
    );
  });
});
