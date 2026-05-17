import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `SystemCard` in `apps/app/src/components/ChatCard.tsx`
// renders a leading "⚠ " glyph before the message body whenever the
// system event is a `StopFailure`. The parent View already carries
// `role="alert"` plus `accessibilityLabel="Error: ${msg.text}"`, which
// is what screen readers announce when the alert fires.
//
// ARIA 1.2: `role="alert"` is NOT atomic for virtual-cursor navigation
// — a virtual cursor (NVDA/JAWS browse mode) can step into the child
// `<Text>` and announce its raw content. The "⚠" character is read as
// "warning sign", producing "warning sign <message>" after the alert
// label already said "Error: <message>", doubling the announcement
// with a confusing prefix. WCAG 1.1.1 (Non-text Content, Level A)
// requires decorative imagery to be skippable by AT.
//
// Native AT (VoiceOver / TalkBack) reads the parent alert and does not
// descend into children, so the fix is web-only and gated on isError.
//
// chat-store is in-memory and SystemCard requires a synthesized
// StopFailure event — can't be seeded from Playwright CI today. Run
// the guard at the source level: assert the SystemCard function body
// contains the "⚠ ${msg.text}" Text and that the opening tag spreads
// a web-only aria-hidden under Platform.OS === "web" && isError. A
// defense-in-depth DOM check vacuously passes today but blocks future
// regressions when SystemCards become seedable.
test.describe("SystemCard error glyph carries aria-hidden on web", () => {
  test("SystemCard ⚠ Text spreads web-only aria-hidden under isError", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    const start = source.indexOf("function SystemCard");
    expect(start).toBeGreaterThan(0);
    const after = start + "function SystemCard".length;
    const next = source
      .slice(after)
      .match(/^(?:export\s+(?:default\s+)?)?function /m);
    expect(next).not.toBeNull();
    const nextOffset = next?.index ?? 0;
    const end = after + nextOffset;
    const body = source.slice(start, end);

    // Strip line comments so the explanatory comment block doesn't trip
    // the regex below — we want to assert against actual JSX only.
    const code = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // The error glyph is rendered as `isError ? `⚠ ${msg.text}` : msg.text`.
    // Find the `⚠` inside the JSX expression body, then walk back to the
    // enclosing <Text> opening tag.
    const glyphIdx = code.indexOf("⚠");
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
    // The spread must gate on both Platform.OS === "web" AND isError so
    // native AT still reads the parent alert and so non-error info
    // notifications continue to expose their text.
    expect(tag).toMatch(
      /Platform\.OS\s*===\s*["']web["']\s*&&\s*isError[\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/,
    );
  });

  // Defense in depth: on the live page, any rendered SystemCard error
  // alert (role="alert" with aria-label starting "Error: ") must not
  // expose the bare ⚠ glyph in its child subtree. chat-store is empty
  // in CI so this is vacuously true today; the assertion blocks a
  // future regression when SystemCards become seedable.
  test("no rendered SystemCard alert exposes ⚠ without aria-hidden", async ({
    page,
  }) => {
    await page.goto("/session/test-system-card-error");
    await page.waitForLoadState("networkidle");

    const leaks = await page.evaluate(() => {
      const found: Array<{ text: string; ariaHidden: string | null }> = [];
      const alerts = document.querySelectorAll(
        '[role="alert"][aria-label^="Error: "]',
      );
      for (const alert of Array.from(alerts)) {
        for (const child of Array.from(alert.querySelectorAll("*"))) {
          const text = (child.textContent ?? "").trim();
          if (!text.includes("⚠")) continue;
          let cursor: Element | null = child;
          let hidden = false;
          while (cursor && cursor !== alert) {
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
