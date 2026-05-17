import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: chat link segments in `apps/app/src/components/ChatCard.tsx`
// render `<Text href=...>` which RN Web rewrites to a real `<a>`. A real
// `<a>` already carries the implicit `role="link"`. A prop-level
// `accessibilityLabel="Link: foo"` becomes `aria-label="Link: foo"` on
// the `<a>`, so NVDA/JAWS announce **"Link: foo, link"** — the role name
// is duplicated, which violates WCAG 2.4.6 (Headings and Labels) and
// degrades the screen-reader experience.
//
// Separately, RN Web's `createDOMProps` drops prop-level
// `accessibilityHint`, so the URL hint ("Opens https://...") never
// reaches web AT — a WCAG 4.1.2 Name/Role/Value parity gap vs native.
//
// Fix: on web, omit `accessibilityLabel`/`accessibilityHint` and rely on
// the visible link text as the accessible name (the natural source for
// `<a>`). Use `title={seg.href}` instead — `title` is a real DOM attr
// that RN Web round-trips, giving sighted users a hover preview and AT
// users programmatic access to the destination URL. Keep the native
// label+hint inside the non-web branch so iOS/Android AT still announce
// both pieces.
//
// WAI-ARIA 1.2 §7.1 Naming Prohibition (don't redundantly include role
// in name). WCAG 2.4.6 Headings and Labels (Level AA). WCAG 4.1.2 Name,
// Role, Value (Level A).
test.describe("Chat link segment avoids redundant aria-label prefix", () => {
  test("ChatCard.tsx link branch does not pass accessibilityLabel on web", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    // Locate the `case "link":` block. It lives inside an inline
    // segment renderer, so slicing by next top-level `function ` would
    // overshoot. We instead slice from `case "link":` to the next
    // top-level `case ` or the closing `default:`.
    const caseStart = source.indexOf('case "link":');
    expect(caseStart).toBeGreaterThan(0);
    const afterCase = caseStart + 'case "link":'.length;
    // Next case label (default included) ends the link case body.
    const nextCaseMatch = source
      .slice(afterCase)
      .match(/^\s*(case |default:)/m);
    expect(nextCaseMatch).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const caseEnd = afterCase + (nextCaseMatch!.index ?? 0);
    const linkBody = source.slice(caseStart, caseEnd);

    // Strip comment lines so documentation can't satisfy the invariant.
    const nonCommentLines = linkBody.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const body = nonCommentLines.join("\n");

    // Locate the web branch — the object literal directly after the
    // `Platform.OS === "web"` ternary. We approximate it as
    // everything between `Platform.OS === "web"` and the matching `: {`
    // (the native branch start). This catches the case where someone
    // re-introduces accessibilityLabel inside the web spread.
    const webBranchStart = body.indexOf('Platform.OS === "web"');
    expect(webBranchStart).toBeGreaterThan(0);
    // The native branch begins with `\n                  : {` — match
    // the colon that separates ternary branches at the same indent.
    const nativeBranchMatch = body.slice(webBranchStart).match(/\n\s*:\s*\{/);
    expect(nativeBranchMatch).not.toBeNull();
    const nativeBranchOffset = nativeBranchMatch?.index ?? 0;
    const webBranch = body.slice(
      webBranchStart,
      webBranchStart + nativeBranchOffset,
    );

    // Invariant 1: web branch must NOT carry the redundant
    // accessibilityLabel="Link: ..." prefix that maps to aria-label.
    expect(webBranch).not.toMatch(/accessibilityLabel/);

    // Invariant 2: web branch must NOT carry accessibilityHint either
    // (RN Web drops it silently). The URL description should be carried
    // by a DOM-passthrough attribute like `title`.
    expect(webBranch).not.toMatch(/accessibilityHint/);

    // Invariant 3: web branch must provide the destination URL via a
    // DOM-passthrough attribute so AT can announce it. We accept
    // `title={...href}` (current fix) or an imperative
    // setAttribute("aria-description", ...) (alternative pattern).
    const hasTitle = /title:\s*\w+\.href/.test(webBranch);
    const hasAriaDescription = /setAttribute\(\s*["']aria-description["']/.test(
      linkBody,
    );
    expect(hasTitle || hasAriaDescription).toBe(true);
  });
});
