import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `PermissionCard` and `ElicitationCard` in
// `apps/app/src/components/ChatCard.tsx` wrap their content in a
// `View` with `role="alert"` plus an `accessibilityLabel` that already
// encodes the full announcement ("Permission required: …, tool: …" /
// "Input requested: …").
//
// ARIA 1.2: `role="alert"` is NOT atomic for virtual-cursor navigation
// — NVDA browse mode / JAWS reading cursor descends into the child
// `<Text>` nodes after the alert label fires and re-announces every
// piece verbatim: "Permission Required" / body text / tool name /
// JSON-stringified toolInput for PermissionCard; "Input Requested" /
// body text / each choice tile for ElicitationCard. The user hears
// the same content twice (label + descendant traversal). WCAG 1.1.1
// (Non-text Content) + 1.3.1 (Info and Relationships).
//
// Native AT (VoiceOver / TalkBack) focuses the parent View and reads
// `accessibilityLabel` directly without descending into children, so
// the gate is web-only. Precedent: SystemCard fix in PR #404
// (`app-system-card-decorative-aria-hidden.spec.ts`).
//
// chat-store is in-memory and these cards only render when the
// daemon delivers a permission_request / elicitation event — not
// seedable from Playwright CI today. Run the guard at the source
// level: assert every child `<Text>` inside the two function bodies
// spreads a web-gated `aria-hidden=true`.

function extractFunctionBody(source: string, fnName: string): string {
  const start = source.indexOf(`function ${fnName}`);
  expect(start, `${fnName} declaration`).toBeGreaterThan(0);
  const after = start + `function ${fnName}`.length;
  const next = source
    .slice(after)
    .match(/^(?:export\s+(?:default\s+)?)?function /m);
  expect(next, `function following ${fnName}`).not.toBeNull();
  const nextOffset = next?.index ?? 0;
  const end = after + nextOffset;
  return source.slice(start, end);
}

function stripComments(body: string): string {
  // Strip JSX block comments `{/* ... */}` so explanatory prose doesn't
  // get matched as JSX. Multiline-aware.
  let code = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip `//` line comments — they reference glyphs/words in prose.
  code = code
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return code;
}

function findChildTextOpenTags(code: string): string[] {
  // Find every `<Text` opening tag in the body. The card's outer
  // wrapper is a `<View>`, so every `<Text>` we encounter is a child
  // of the alert and must carry the web-only aria-hidden spread.
  const tags: string[] = [];
  let cursor = 0;
  while (cursor < code.length) {
    const tagStart = code.indexOf("<Text", cursor);
    if (tagStart < 0) break;
    // Skip `<TextInput` if it ever appears — not a child Text node.
    const after = code.slice(tagStart, tagStart + 10);
    if (/^<Text[A-Za-z]/.test(after)) {
      cursor = tagStart + 5;
      continue;
    }
    const tagEnd = code.indexOf(">", tagStart);
    if (tagEnd < 0) break;
    tags.push(code.slice(tagStart, tagEnd + 1));
    cursor = tagEnd + 1;
  }
  return tags;
}

const ARIA_HIDDEN_SPREAD =
  /Platform\.OS\s*===\s*["']web["'][\s\S]{0,200}?["']aria-hidden["']\s*:\s*true/;

test.describe("PermissionCard / ElicitationCard child Text aria-hidden on web", () => {
  const sourcePath = resolve(
    __dirname,
    "../apps/app/src/components/ChatCard.tsx",
  );

  test("every PermissionCard child <Text> spreads web-only aria-hidden", () => {
    const source = readFileSync(sourcePath, "utf8");
    const body = extractFunctionBody(source, "PermissionCard");
    const code = stripComments(body);

    const tags = findChildTextOpenTags(code);
    // Source today renders 4 child Text nodes (header, body, tool name,
    // toolInput preview). Allow the count to grow but require ≥2.
    expect(tags.length).toBeGreaterThanOrEqual(2);

    for (const tag of tags) {
      // Either the tag itself carries the spread (inline) or the body
      // assigns `ariaHiddenWeb` and spreads it. Both satisfy the regex
      // when the spread is inline, but the helper-variable pattern
      // needs a separate check.
      const hasInlineSpread = ARIA_HIDDEN_SPREAD.test(tag);
      const hasHelperSpread = /\{\.\.\.ariaHiddenWeb\}/.test(tag);
      expect(
        hasInlineSpread || hasHelperSpread,
        `<Text ...> in PermissionCard missing web-only aria-hidden: ${tag}`,
      ).toBe(true);
    }

    // If the helper-variable pattern is used, the helper must itself
    // be gated on Platform.OS === "web" so native AT keeps reading
    // the children for VoiceOver/TalkBack consistency.
    if (/\{\.\.\.ariaHiddenWeb\}/.test(code)) {
      const helperDecl = code.match(/ariaHiddenWeb\s*=[\s\S]{0,200}?;/);
      expect(helperDecl, "ariaHiddenWeb declaration").not.toBeNull();
      expect(helperDecl?.[0] ?? "").toMatch(ARIA_HIDDEN_SPREAD);
    }
  });

  test("every ElicitationCard child <Text> spreads web-only aria-hidden", () => {
    const source = readFileSync(sourcePath, "utf8");
    const body = extractFunctionBody(source, "ElicitationCard");
    const code = stripComments(body);

    const tags = findChildTextOpenTags(code);
    // Header + body + at-least-one choice item Text in the map. Require ≥2.
    expect(tags.length).toBeGreaterThanOrEqual(2);

    for (const tag of tags) {
      const hasInlineSpread = ARIA_HIDDEN_SPREAD.test(tag);
      const hasHelperSpread = /\{\.\.\.ariaHiddenWeb\}/.test(tag);
      expect(
        hasInlineSpread || hasHelperSpread,
        `<Text ...> in ElicitationCard missing web-only aria-hidden: ${tag}`,
      ).toBe(true);
    }

    if (/\{\.\.\.ariaHiddenWeb\}/.test(code)) {
      const helperDecl = code.match(/ariaHiddenWeb\s*=[\s\S]{0,200}?;/);
      expect(helperDecl, "ariaHiddenWeb declaration").not.toBeNull();
      expect(helperDecl?.[0] ?? "").toMatch(ARIA_HIDDEN_SPREAD);
    }
  });

  // Defense in depth: on the live page, any rendered Permission /
  // Elicitation alert (role="alert" with aria-label starting
  // "Permission required: " / "Input requested: ") must not expose
  // child text content to the a11y tree. chat-store is empty in CI
  // so this is vacuously true today; the assertion blocks a future
  // regression when these cards become seedable.
  test("no rendered Permission/Elicitation alert exposes children to AT", async ({
    page,
  }) => {
    await page.goto("/session/test-permission-elicitation-card");
    await page.waitForLoadState("networkidle");

    const leaks = await page.evaluate(() => {
      const found: Array<{ alertLabel: string; text: string }> = [];
      const alerts = document.querySelectorAll(
        '[role="alert"][aria-label^="Permission required: "], [role="alert"][aria-label^="Input requested: "]',
      );
      for (const alert of Array.from(alerts)) {
        const alertLabel = alert.getAttribute("aria-label") ?? "";
        for (const child of Array.from(alert.querySelectorAll("*"))) {
          const text = (child.textContent ?? "").trim();
          if (!text) continue;
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
            found.push({ alertLabel, text });
          }
        }
      }
      return found;
    });

    expect(leaks).toEqual([]);
  });
});
