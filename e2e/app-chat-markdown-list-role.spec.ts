import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `RichText` in `apps/app/src/components/ChatCard.tsx`
// renders a markdown list (`- item` / `1. item`) as a sequence of
// generic `<View>` rows with a leading `•` / `1.` Text glyph. Sighted
// users see the marker; screen readers (NVDA/JAWS/VoiceOver) see a
// run of generic <div>s with no list semantics — they don't announce
// "list with N items" and the L/I list-navigation shortcuts don't
// activate. WCAG 1.3.1 (Info and Relationships, Level A) requires
// structure conveyed visually to be programmatically determined.
//
// Fix: in the `case "list":` branch, spread `role="list"` on the
// outer container and `role="listitem"` on each row, web-only via a
// Platform.OS gate (RN's AccessibilityRole union excludes both
// roles). Same pattern already used by `app-chat-list-ownership.spec.ts`
// and `app-daemons-list-ownership.spec.ts`.
//
// Since chat-store is in-memory (can't be seeded from Playwright),
// this spec uses a source-level invariant — same defense-in-depth
// approach as `app-chat-bubble-role.spec.ts`. We read ChatCard.tsx,
// slice out the `case "list":` body, strip comment lines, and assert
// the body contains both `role="list"` and `role="listitem"`.
test("RichText list block emits role=list and role=listitem on web", () => {
  const source = readFileSync(
    resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
    "utf8",
  );

  const listCaseStart = source.indexOf('case "list":');
  expect(listCaseStart).toBeGreaterThan(0);

  // The list case ends at the next `case "<name>":` sibling. We don't
  // know exactly which case comes next, but parseBlocks emits "para"
  // and "code" and "heading" — pick the first sibling encountered.
  const afterListStart = listCaseStart + 'case "list":'.length;
  const nextCaseMatch = source
    .slice(afterListStart)
    .match(/^\s*case "[a-z]+":/m);
  expect(nextCaseMatch).not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted above
  const listCaseEnd = afterListStart + (nextCaseMatch!.index ?? 0);
  const listCaseBody = source.slice(listCaseStart, listCaseEnd);

  // Filter out comment lines so documentation about role can't
  // satisfy the invariant.
  const nonCommentLines = listCaseBody.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*");
  });
  const body = nonCommentLines.join("\n");

  // role="list" on the outer container
  expect(body).toMatch(/role:\s*["']list["']/);
  // role="listitem" on each item row
  expect(body).toMatch(/role:\s*["']listitem["']/);
});
