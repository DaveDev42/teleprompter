import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `InAppToast` in `apps/app/src/components/InAppToast.tsx`
// renders a bare `✕` dismiss glyph inside a Pressable that lives
// *inside* the outer `role="status"` live region. The Pressable itself
// exposes `accessibilityLabel="Dismiss notification"`, which only
// affects the button's accessible name when focused — it does NOT
// substitute the descendant text content when the parent region's
// announcement is computed.
//
// NVDA / JAWS compute the announcement of a `role="status"` (or
// `aria-live="polite"`) region from the region's raw DOM textContent,
// flattened. So a toast like
//   `<View role="status">Paired daemon-abc connected.<Pressable>✕</Pressable></View>`
// announces as `"Paired daemon-abc connected. ✕"` — the `✕` (U+2715
// MULTIPLICATION X) is verbalized as "times" / "x" / "multiplication
// sign" depending on the AT, polluting every toast.
//
// WCAG 1.1.1 (Non-text Content, Level A) requires decorative glyphs to
// be skippable by AT. WCAG 4.1.3 (Status Messages, Level AA) requires
// status announcements to be coherent — trailing decorative glyphs
// hurt comprehension.
//
// Fix: spread `aria-hidden=true` on the `✕` Text under
// `Platform.OS === "web"`. Native AT (VoiceOver/TalkBack) focuses the
// parent Pressable and reads its accessibilityLabel, never descending
// into the child Text, so the gate is web-only.
//
// notification-store is in-memory and a toast can't be reliably seeded
// from headless Playwright without paired-daemon state. Guard the
// regression at the source level: assert the InAppToast function body
// contains a `<Text>...✕...</Text>` whose opening tag spreads
// `aria-hidden: true` under `Platform.OS === "web"`. Defense-in-depth
// DOM check on the live page vacuously passes today but blocks a
// future regression when toasts become seedable.
test.describe("InAppToast dismiss glyph carries aria-hidden on web", () => {
  test("InAppToast ✕ Text spreads web-only aria-hidden", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/InAppToast.tsx"),
      "utf8",
    );

    const start = source.indexOf("function InAppToast");
    expect(start).toBeGreaterThan(0);
    const after = start + "function InAppToast".length;
    const next = source
      .slice(after)
      .match(/^(?:export\s+(?:default\s+)?)?function /m);
    // InAppToast may be the last top-level function in the file — that's
    // fine, treat the whole rest as the body.
    const nextOffset = next?.index ?? source.length - after;
    const end = after + nextOffset;
    const body = source.slice(start, end);

    // Strip JSX `{/* ... */}` block comments and `// ...` line comments so
    // the explanatory comment block (which mentions both `✕` and
    // `aria-hidden`) doesn't satisfy the assertion vacuously.
    const code = body
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // Find the `✕` glyph (U+2715) in the JSX body.
    const glyphIdx = code.indexOf("✕");
    expect(glyphIdx).toBeGreaterThan(0);

    // Walk backwards over `<Text` openings until we find one whose closing
    // `</Text>` sits past the glyph position — that's the enclosing element.
    let searchFrom = glyphIdx;
    let enclosingTagStart = -1;
    let enclosingTagEnd = -1;
    while (searchFrom > 0) {
      const tagStart = code.lastIndexOf("<Text", searchFrom);
      if (tagStart < 0) break;
      const tagEnd = code.indexOf(">", tagStart);
      if (tagEnd < 0) break;
      const closeIdx = code.indexOf("</Text>", tagEnd);
      if (closeIdx > glyphIdx) {
        enclosingTagStart = tagStart;
        enclosingTagEnd = tagEnd;
        break;
      }
      searchFrom = tagStart - 1;
    }
    expect(enclosingTagStart).toBeGreaterThan(0);
    expect(enclosingTagEnd).toBeGreaterThan(enclosingTagStart);

    const tag = code.slice(enclosingTagStart, enclosingTagEnd);
    expect(tag).toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );
  });

  // Defense in depth: on the live page, the InAppToast live region
  // is always mounted (empty placeholder when no toast is active).
  // Any time a `[role="status"]` region renders content, its textContent
  // must not include a bare `✕`. notification-store is empty in CI so
  // this is vacuously true today; the assertion blocks a future
  // regression when toasts become seedable.
  test("no rendered role=status region exposes ✕ without aria-hidden", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const leaks = await page.evaluate(() => {
      const found: Array<{ region: string; text: string }> = [];
      const regions = document.querySelectorAll('[role="status"]');
      for (const region of Array.from(regions)) {
        for (const child of Array.from(region.querySelectorAll("*"))) {
          const text = (child.textContent ?? "").trim();
          if (!text.includes("✕")) continue;
          let cursor: Element | null = child;
          let hidden = false;
          while (cursor && cursor !== region) {
            if (cursor.getAttribute("aria-hidden") === "true") {
              hidden = true;
              break;
            }
            cursor = cursor.parentElement;
          }
          if (!hidden) {
            found.push({
              region: region.getAttribute("aria-label") ?? "",
              text,
            });
          }
        }
      }
      return found;
    });

    expect(leaks).toEqual([]);
  });
});
