import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `ToolCard` in `apps/app/src/components/ChatCard.tsx`
// renders three pieces of decorative text inside the card's
// Pressable:
//   1. `▸` / `▾` disclosure glyph (line ~784)
//   2. "Done" / "Running" status badge (line ~794)
//   3. "Show more" / "Show less" expansion affordance (line ~864)
// The parent Pressable already carries an `accessibilityLabel` like
// "Tool Bash, completed, collapsed" plus `aria-expanded` (for
// actionable cards) and `role="group"` (for static ones). All three
// inner Texts duplicate that semantic information visually.
//
// ARIA 1.2: `role="group"` is NOT atomic for virtual-cursor
// navigation — a virtual cursor can step into the children and AT
// will announce raw text content like "BLACK DOWN-POINTING SMALL
// TRIANGLE" or a stray "Done" tail after the group's accessible
// name. WCAG 1.1.1 (Non-text Content, Level A) requires decorative
// imagery to be exposed in a way that AT can ignore. The standard
// pattern is `aria-hidden="true"` on the decorative element.
//
// Native AT (VoiceOver / TalkBack) reads the parent Pressable's
// accessibilityLabel and does not descend into children for
// role=group / role=button, so the fix is web-only.
//
// chat-store is in-memory and ToolCard requires a synthesized
// PostToolUse message — can't be seeded from Playwright CI today.
// Run the guard at the source level: assert the ToolCard function
// body contains the three decorative Texts and each is wrapped in a
// Platform.OS === "web" aria-hidden spread. Defense-in-depth DOM
// check on a live page vacuously passes today but blocks future
// regressions when ToolCards become seedable.
test.describe("ToolCard decorative children carry aria-hidden on web", () => {
  test("ToolCard glyph + status + show-more all carry web-only aria-hidden", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function ToolCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function ToolCard".length;
    const next = source
      .slice(after)
      .match(/^(?:export\s+(?:default\s+)?)?function /m);
    expect(next).not.toBeNull();
    const nextOffset = next?.index ?? 0;
    const end = after + nextOffset;
    const body = source.slice(start, end);

    // Disclosure glyph (▸ / ▾) — must be aria-hidden on web.
    const glyphMatch = body.match(
      /<Text[^>]*?>\s*\{\s*isResult\s*\?\s*\(\s*expanded\s*\?\s*["']▾["']/,
    );
    expect(glyphMatch).not.toBeNull();
    // Find the <Text ...> opening tag that contains the glyph expression
    // and assert it spreads aria-hidden under Platform.OS === "web".
    const glyphIdx = body.indexOf('"▾"');
    expect(glyphIdx).toBeGreaterThan(0);
    const glyphTagStart = body.lastIndexOf("<Text", glyphIdx);
    const glyphTagEnd = body.indexOf(">", glyphIdx);
    const glyphTag = body.slice(glyphTagStart, glyphTagEnd);
    expect(glyphTag).toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );

    // Status badge (Done / Running) — must be aria-hidden on web.
    const statusIdx = body.indexOf('"Done" : "Running"');
    expect(statusIdx).toBeGreaterThan(0);
    const statusTagStart = body.lastIndexOf("<Text", statusIdx);
    const statusTagEnd = body.indexOf(">", statusIdx);
    const statusTag = body.slice(statusTagStart, statusTagEnd);
    expect(statusTag).toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );

    // Show more / Show less affordance — must be aria-hidden on web.
    const showIdx = body.indexOf('"Show less" : "Show more"');
    expect(showIdx).toBeGreaterThan(0);
    const showTagStart = body.lastIndexOf("<Text", showIdx);
    const showTagEnd = body.indexOf(">", showIdx);
    const showTag = body.slice(showTagStart, showTagEnd);
    expect(showTag).toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );
  });

  // Defense in depth: on the live page, any rendered ToolCard's
  // [role="group"] / [role="button"] container must not expose the
  // bare disclosure glyph or duplicated badge string. chat-store is
  // empty in CI so this is vacuously true today; the assertion
  // blocks a future regression when ToolCards become seedable.
  test("no rendered ToolCard child node exposes ▸/▾/Done/Running/Show more/Show less without aria-hidden", async ({
    page,
  }) => {
    await page.goto("/session/test-tool-card-decorative");
    await page.waitForLoadState("networkidle");

    const leaks = await page.evaluate(() => {
      const decorative = new Set([
        "▸",
        "▾",
        "Done",
        "Running",
        "Show more",
        "Show less",
      ]);
      const found: Array<{ text: string; ariaHidden: string | null }> = [];
      // Tool cards announce themselves with "Tool <name>" as aria-label.
      const containers = document.querySelectorAll(
        '[role="group"][aria-label^="Tool "], [role="button"][aria-label^="Tool "]',
      );
      for (const container of Array.from(containers)) {
        for (const child of Array.from(container.querySelectorAll("*"))) {
          const text = (child.textContent ?? "").trim();
          if (!decorative.has(text)) continue;
          // Only flag if the immediate text-bearing element exposes the
          // decorative string (children with extra wrappers can also be
          // hidden by an ancestor; require an aria-hidden hit somewhere
          // up the ancestor chain inside the container).
          let cursor: Element | null = child;
          let hidden = false;
          while (cursor && cursor !== container) {
            if (cursor.getAttribute("aria-hidden") === "true") {
              hidden = true;
              break;
            }
            cursor = cursor.parentElement;
          }
          if (!hidden) {
            found.push({
              text,
              ariaHidden: child.getAttribute("aria-hidden"),
            });
          }
        }
      }
      return found;
    });

    expect(leaks).toEqual([]);
  });
});
