import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: `SessionRow` in `apps/app/app/(tabs)/index.tsx` paints a
// "running" / "stopped" state via a small `<View>` color dot (line ~90)
// and conditionally renders an active-row accent bar (line ~85) and a
// row divider (line ~137). All three are decorative — the parent
// Pressable already carries `accessibilityLabel` ("project, running")
// that names both the session and its state. role="button" is NOT
// atomic for NVDA Browse / JAWS Reading Cursor traversal, so the
// virtual cursor descends into the row and stops on each empty <div>,
// padding the readout with meaningless pauses.
//
// WCAG 1.1.1 Non-text Content (Level A): decorative children that
// duplicate or supplement content already in the parent's accessible
// name must be hidden from AT.
//
// CI build serves `apps/app/dist` with no daemon, so `SessionRow` is
// never rendered (the sessions list stays empty). Mirror the
// source-level assertion pattern used by
// `app-session-row-chevron-aria-hidden.spec.ts` for the chevron Text
// fix — slice the SessionRow function body, strip comments, and check
// that each decorative <View> open tag carries the web-only
// aria-hidden spread.

test("SessionRow status dot, active bar, divider Views all spread web-only aria-hidden in source", () => {
  const filePath = resolve(__dirname, "../apps/app/app/(tabs)/index.tsx");
  const raw = readFileSync(filePath, "utf-8");

  const rowFnStart = raw.indexOf("function SessionRow(");
  expect(rowFnStart, "SessionRow function declaration").toBeGreaterThan(-1);
  const rowFnEnd = raw.indexOf(
    "export default function SessionsScreen",
    rowFnStart,
  );
  expect(rowFnEnd, "SessionsScreen follows SessionRow").toBeGreaterThan(
    rowFnStart,
  );
  let body = raw.slice(rowFnStart, rowFnEnd);

  // Strip JSX block comments `{/* ... */}` and line comments so prose
  // tokens like "Status dot" / "aria-hidden" don't trip the regex.
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  body = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // Each decorative View is identifiable by a unique className substring.
  // For each match, locate the enclosing `<View` opening tag (walking
  // backwards from the className hit) and assert the open tag carries
  // the web-only aria-hidden spread.
  const decorativeMarkers = [
    "absolute left-0 top-4 bottom-4 w-[3px] rounded-full bg-tp-accent", // active indicator
    "w-2 h-2 rounded-full mr-3", // status dot
    "h-[0.5px] bg-tp-border ml-[52px] mr-4", // divider
  ];

  for (const marker of decorativeMarkers) {
    const markerIdx = body.indexOf(marker);
    expect(markerIdx, `decorative marker "${marker}"`).toBeGreaterThan(-1);

    const beforeMarker = body.slice(0, markerIdx);
    const viewTagStart = beforeMarker.lastIndexOf("<View");
    expect(
      viewTagStart,
      `enclosing <View> for marker "${marker}"`,
    ).toBeGreaterThan(-1);

    // The View is self-closing (`/>`). Walk forward until the matching
    // `/>` at JSX brace depth 0, just like other source-level spec
    // patterns.
    const fromView = body.slice(viewTagStart);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < fromView.length; i++) {
      const ch = fromView[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "/" && depth === 0 && fromView[i + 1] === ">") {
        endIdx = i + 1;
        break;
      }
    }
    expect(
      endIdx,
      `<View /> self-close for marker "${marker}"`,
    ).toBeGreaterThan(-1);
    const openTag = fromView.slice(0, endIdx + 1);

    expect(
      openTag,
      `web-only aria-hidden spread on <View> for marker "${marker}"`,
    ).toMatch(/Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/);
  }
});
