import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: `ToolCard` in `apps/app/src/components/ChatCard.tsx`
// uses `accessibilityRole={isActionable ? "button" : undefined}`. When
// `isActionable` is false (running tool call, or completed but short
// non-truncatable result), the Pressable has no role. RN Web emits a
// generic <div>. Per WAI-ARIA 1.2 §7.1 (Naming Prohibition), aria-label
// on a generic element is silently ignored by NVDA/JAWS/VoiceOver — so
// the carefully crafted "Tool <name>, running/completed" label never
// reaches AT users. Same bug class as BUG-80 (UserCard/AssistantCard
// with accessibilityRole="text").
//
// Fix: spread `role="group"` on web when `!isActionable`. Actionable
// tool cards already get role=button which is sufficient (button can
// be named). The `role="group"` matches the pattern UserCard /
// AssistantCard adopted in BUG-80.
//
// WAI-ARIA 1.2 §7.1: aria-label is prohibited on role=generic and
// dropped by AT. WCAG 2.1 SC 4.1.2 (Level A): name, role, value must
// be programmatically determinable.
test.describe("ToolCard role surfaces aria-label on web", () => {
  test("ChatCard.tsx ToolCard non-actionable path spreads role=group on web", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    // Locate the ToolCard component definition.
    const toolCardStart = source.indexOf("function ToolCard");
    expect(toolCardStart).toBeGreaterThan(0);

    // ToolCard ends at the next top-level `function ` declaration
    // (PermissionCard / ElicitationCard / etc. are siblings).
    const afterToolCard = toolCardStart + "function ToolCard".length;
    const nextFnMatch = source.slice(afterToolCard).match(/^function /m);
    expect(nextFnMatch).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const toolCardEnd = afterToolCard + (nextFnMatch!.index ?? 0);
    const toolCardBody = source.slice(toolCardStart, toolCardEnd);

    // Strip comment lines so documentation can't satisfy the invariant.
    const nonCommentLines = toolCardBody.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const body = nonCommentLines.join("\n");

    // Either a `role: "group"` literal (Platform-gated props bag) or a
    // direct `role="group"` JSX prop must appear within ToolCard's
    // non-actionable branch on web. Pattern matches both spread-object
    // form and JSX attribute form.
    const hasGroupRole = /role:\s*["']group["']|role=["']group["']/.test(body);
    expect(hasGroupRole).toBe(true);
  });

  // Defense in depth: scan the live app and assert that no element with
  // an aria-label starting with "Tool " carries a generic (or absent)
  // role. The chat-store is in-memory so we can't seed messages from
  // Playwright — but if for any reason a ToolCard does render in the
  // wild (e.g., a regression introduces one to a settings screen), this
  // catches it. The chat-store starts empty so this assertion is vacuously
  // true today but blocks future regressions.
  const routesToScan = [
    "/",
    "/daemons",
    "/settings",
    "/pairing",
    "/pairing/scan",
    "/session/test-tool-card-role-invariant",
  ];

  for (const route of routesToScan) {
    test(`tool-card aria-label has non-generic role on ${route}`, async ({
      page,
    }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const offenders = await page.evaluate(() => {
        const result: Array<{ label: string | null; role: string | null }> = [];
        for (const el of Array.from(
          document.querySelectorAll("[aria-label]"),
        )) {
          const label = el.getAttribute("aria-label");
          if (!label || !label.startsWith("Tool ")) continue;
          const role = el.getAttribute("role");
          if (!role || role === "" || role === "generic") {
            result.push({ label, role });
          }
        }
        return result;
      });

      expect(offenders).toEqual([]);
    });
  }
});
