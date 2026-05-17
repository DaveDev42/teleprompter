import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: in `apps/app/app/(tabs)/settings.tsx`, the
// `UpdateStatusValue` component renders a small colored status dot
// (`<View className="w-2 h-2 rounded-full ..." />`) next to the
// "Up to date" / "Update available" text labels. Unlike the
// equivalent dots on `DaemonCard` (online/offline) and `SessionRow`
// (running/stopped), these dots did NOT spread `aria-hidden` on web.
//
// The dots live inside the Updates row, which is a `role="button"`
// with `aria-label="Updates, …"`. On web NVDA browse-mode and JAWS
// reading-cursor are NOT atomic for role=button — the virtual cursor
// descends into the button's subtree and reads each child node.
// Empty `<div>`s with no text content produce a brief content-less
// pause / "blank" announcement that interrupts the reading flow
// without conveying information (the text "Up to date" already
// carries the state).
//
// Fix: spread `{ "aria-hidden": true }` on the two dot Views on web,
// matching the established pattern from DaemonCard line 74 and the
// SessionRow status dot (covered by
// `app-session-row-status-dot-aria-hidden.spec.ts`).
//
// WCAG 1.1.1 Non-text Content (Level A). WCAG 1.3.1 Info and
// Relationships (Level A).
test.describe("UpdateStatusValue status dots are aria-hidden on web", () => {
  test("(tabs)/settings.tsx UpdateStatusValue dot Views spread aria-hidden on web", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/app/(tabs)/settings.tsx"),
      "utf8",
    );

    // Locate the UpdateStatusValue function body. It is a top-level
    // `function UpdateStatusValue(...)` declaration; slice until the
    // next top-level function declaration of any flavor.
    const fnStart = source.indexOf("function UpdateStatusValue");
    expect(fnStart, "UpdateStatusValue function declaration").toBeGreaterThan(
      -1,
    );
    const afterFn = fnStart + "function UpdateStatusValue".length;
    const nextFnMatch = source
      .slice(afterFn)
      .match(/^(?:export\s+(?:default\s+)?)?function /m);
    expect(nextFnMatch).not.toBeNull();
    const fnEnd = afterFn + (nextFnMatch?.index ?? 0);
    const fnBody = source.slice(fnStart, fnEnd);

    // Strip comments so documentation can't satisfy the invariant.
    const nonCommentLines = fnBody.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const body = nonCommentLines.join("\n");

    // Both colored dot Views (one inside the `up-to-date` branch with
    // `bg-tp-success`, one inside the `available`/`ready` branch with
    // `bg-tp-accent`) must spread the web-only aria-hidden pattern.
    // Each is a `<View className="w-2 h-2 rounded-full ..." />` —
    // anchor on `rounded-full` because the className tokens may
    // re-order under formatter passes.
    for (const colorToken of ["bg-tp-success", "bg-tp-accent"]) {
      const dotIdx = body.indexOf(colorToken);
      expect(dotIdx, `dot View with "${colorToken}"`).toBeGreaterThan(-1);

      // Look forward past the dot's `<View ... />` open tag until the
      // self-closing `/>` or `>`. The aria-hidden spread sits inside
      // that open tag.
      const tagStart = body.lastIndexOf("<View", dotIdx);
      expect(tagStart, `enclosing <View for ${colorToken}`).toBeGreaterThan(-1);
      const tagEnd = body.indexOf("/>", tagStart);
      expect(tagEnd, `self-closing /> for ${colorToken}`).toBeGreaterThan(-1);

      const tag = body.slice(tagStart, tagEnd);
      expect(
        tag,
        `dot View with "${colorToken}" must spread web-only aria-hidden`,
      ).toMatch(/Platform\.OS\s*===\s*"web"[\s\S]*"aria-hidden"\s*:\s*true/);
    }
  });
});
