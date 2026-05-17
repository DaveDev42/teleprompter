import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: `StreamingCard` in `apps/app/src/components/ChatCard.tsx`
// renders a `role="status"` live region that announces "Claude is
// typing" + the partially streamed `msg.text` chunk. Per ARIA 1.2
// §6.3.2, role=status implies aria-atomic=true — but NVDA/JAWS
// historically ignore the implicit value, and RN Web 0.21's
// createDOMProps strips prop-level `aria-atomic` from `<View>` (only a
// curated allowlist of aria-* attrs round-trips). The combined effect
// is that as `msg.text` ticks character-by-character with each PTY
// chunk, AT users hear only the diff fragments instead of the full
// streamed sentence — a regression in announcement parity vs. the
// finalized AssistantCard.
//
// Fix: ref the outer View, useEffect to imperatively
// setAttribute("aria-atomic", "true") on web. Matches the established
// pattern used by ConnectionLiveRegion (session/[sid].tsx),
// InAppToast.tsx, DiagnosticsPanel.tsx, FontPickerModal.tsx,
// VoiceButton.tsx, settings.tsx.
//
// WAI-ARIA 1.2 §6.3.2 (status): implicit aria-atomic=true. WCAG 4.1.3
// Status Messages (Level AA): status messages must be programmatically
// determinable so AT can announce them. WCAG 4.1.2 (Name, Role, Value).
test.describe("StreamingCard sets aria-atomic imperatively on web", () => {
  test("ChatCard.tsx StreamingCard body contains setAttribute aria-atomic", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/src/components/ChatCard.tsx"),
      "utf8",
    );

    // Locate the StreamingCard function definition.
    const streamingStart = source.indexOf("function StreamingCard");
    expect(streamingStart).toBeGreaterThan(0);

    // StreamingCard ends at the next top-level `function ` declaration.
    const afterStreaming = streamingStart + "function StreamingCard".length;
    const nextFnMatch = source.slice(afterStreaming).match(/^function /m);
    expect(nextFnMatch).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const streamingEnd = afterStreaming + (nextFnMatch!.index ?? 0);
    const streamingBody = source.slice(streamingStart, streamingEnd);

    // Strip comment lines so documentation can't satisfy the invariant.
    const nonCommentLines = streamingBody.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const body = nonCommentLines.join("\n");

    // Must contain an imperative setAttribute call carrying the
    // aria-atomic literal. Matches the project-wide pattern:
    //   el.setAttribute("aria-atomic", "true");
    expect(body).toMatch(
      /setAttribute\(\s*["']aria-atomic["']\s*,\s*["']true["']\s*\)/,
    );

    // And must wire a ref onto the live region View so the effect has
    // a DOM node to target.
    expect(body).toMatch(/ref=\{[^}]*\}/);
    expect(body).toMatch(/useRef</);
    expect(body).toMatch(/useEffect\(/);
  });
});
