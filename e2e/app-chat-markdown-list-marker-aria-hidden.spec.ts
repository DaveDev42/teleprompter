import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `RichText` in `apps/app/src/components/ChatCard.tsx`
// renders a markdown list as `role="listitem"` rows with a leading
// `•` (unordered) or `${n}.` (ordered) marker `<Text>` glyph. The
// `role="listitem"` context already conveys the list structure to
// NVDA/JAWS/VO ("list with N items, 1 of N: ..."); the visible glyph
// is purely a sighted-user affordance. If the marker Text is exposed
// to AT, every list entry is double-announced as "bullet <item text>"
// or "one dot <item text>", polluting the readout.
//
// role=listitem is NOT atomic for virtual-cursor navigation — AT can
// step into the children. WCAG 1.1.1 (Non-text Content, Level A)
// requires decorative non-text content to be skippable. The fix is
// `aria-hidden=true` on the marker Text, gated to web only. Native
// AT (VoiceOver/TalkBack) treats listitem children as part of the
// item label and doesn't double-announce, so the gate stays web-only.
//
// chat-store is in-memory and a list block requires a synthesized
// assistant message — can't be seeded from Playwright CI today. Guard
// at the source level: slice the `case "list":` body in ChatCard.tsx,
// strip line comments + JSX block comments, locate the marker `<Text>`
// containing the `${ii + 1}.` / `•` expression, and assert its opening
// tag spreads `aria-hidden: true` under `Platform.OS === "web"`. This
// mirrors the existing `app-chat-markdown-list-role.spec.ts` source
// invariant and the `app-tool-card-decorative-aria-hidden.spec.ts` /
// `app-system-card-decorative-aria-hidden.spec.ts` family.
test("RichText list block marker Text carries web-only aria-hidden", () => {
  const source = readFileSync(
    resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
    "utf8",
  );

  const listCaseStart = source.indexOf('case "list":');
  expect(listCaseStart).toBeGreaterThan(0);

  const afterListStart = listCaseStart + 'case "list":'.length;
  const nextCaseMatch = source
    .slice(afterListStart)
    .match(/^\s*case "[a-z]+":/m);
  expect(nextCaseMatch).not.toBeNull();
  const listCaseEnd = afterListStart + (nextCaseMatch?.index ?? 0);
  const listCaseBody = source.slice(listCaseStart, listCaseEnd);

  // Strip JSX `{/* ... */}` block comments and `// ...` line comments
  // so the explanatory comment block (which mentions both "•" and
  // "aria-hidden") doesn't satisfy the regex vacuously.
  const stripped = listCaseBody
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");

  // The marker JSX is `{block.ordered ? `${ii + 1}.` : "•"}` — locate
  // the `•` literal as the anchor.
  const glyphIdx = stripped.indexOf('"•"');
  expect(glyphIdx).toBeGreaterThan(0);

  // Walk backwards to the enclosing `<Text` opening whose closing
  // `</Text>` sits past the glyph.
  let searchFrom = glyphIdx;
  let enclosingTagStart = -1;
  let enclosingTagEnd = -1;
  while (searchFrom > 0) {
    const tagStart = stripped.lastIndexOf("<Text", searchFrom);
    if (tagStart < 0) break;
    const tagEnd = stripped.indexOf(">", tagStart);
    if (tagEnd < 0) break;
    const closeIdx = stripped.indexOf("</Text>", tagEnd);
    if (closeIdx > glyphIdx) {
      enclosingTagStart = tagStart;
      enclosingTagEnd = tagEnd;
      break;
    }
    searchFrom = tagStart - 1;
  }
  expect(enclosingTagStart).toBeGreaterThan(0);
  expect(enclosingTagEnd).toBeGreaterThan(enclosingTagStart);

  const tag = stripped.slice(enclosingTagStart, enclosingTagEnd);
  expect(tag).toMatch(
    /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
  );
});
