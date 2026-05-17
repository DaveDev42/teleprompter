import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Regression: the "Run Self-Test" Pressable in DiagnosticsPanel used a
// native `disabled={cryptoTest.running}` prop. RN Web's Pressable
// forwards `disabled` to the underlying `<button>`'s native HTML
// `disabled` attribute, which removes the element from the keyboard
// Tab sequence entirely. A keyboard-only user (and NVDA browse mode /
// JAWS virtual cursor / VoiceOver linear nav) momentarily loses access
// to the button while the self-test is running — the button vanishes
// from the document instead of just announcing its inert state.
//
// The codebase's documented pattern (ApiKeyModal save, FontPickerModal
// boundary buttons) is: omit native `disabled`, keep the Pressable
// focusable, gate the handler in JS, and announce inertness via
// imperative `setAttribute("aria-disabled", ...)` from a `useEffect`.
//
// WCAG 2.1.1 Keyboard (Level A): all functionality must remain
// keyboard-operable. APG "Button" §4 allows aria-disabled buttons to
// retain focus so users can still discover the control.
//
// Source-level invariant: opening the Diagnostics panel + clicking
// Run Self-Test + asserting tab order during the ~8ms running window
// is too brittle for CI. Instead, assert that `DiagnosticsPanel.tsx`
// does NOT pass `disabled={cryptoTest.running}` (or any `disabled=`)
// to the Run Self-Test Pressable, and that an imperative aria-disabled
// effect targeting the button ref is present.
test(
  "DiagnosticsPanel Run Self-Test omits native disabled and uses imperative aria-disabled",
  () => {
    const filePath = resolve(
      __dirname,
      "../apps/app/src/components/DiagnosticsPanel.tsx",
    );
    let body = readFileSync(filePath, "utf-8");

    // Strip JSX block comments `{/* ... */}` and `//` line comments so
    // we don't match prose mentions of the prop.
    body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    body = body.replace(/\/\*[\s\S]*?\*\//g, "");
    body = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // Slice the Run Self-Test Pressable: from `onPress={handleCryptoTest}`
    // back to the nearest `<Pressable` and forward to the matching `>`.
    const onPressIdx = body.indexOf("onPress={handleCryptoTest}");
    expect(onPressIdx, "onPress={handleCryptoTest} call site").toBeGreaterThan(
      -1,
    );
    const before = body.slice(0, onPressIdx);
    const pressableStart = before.lastIndexOf("<Pressable");
    expect(pressableStart, "enclosing <Pressable for Run Self-Test").toBeGreaterThan(
      -1,
    );
    const fromPressable = body.slice(pressableStart);
    // The open tag of <Pressable ...> ends at the first `>` that is
    // followed by a newline or whitespace + child JSX. The Pressable
    // here is multi-line; find the matching `>` by walking until the
    // depth-0 close.
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < fromPressable.length; i++) {
      const ch = fromPressable[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        endIdx = i;
        break;
      }
    }
    expect(endIdx, "open <Pressable> tag terminator").toBeGreaterThan(-1);
    const pressableOpen = fromPressable.slice(0, endIdx + 1);

    // Invariant 1: the open tag must NOT carry a native `disabled=` prop.
    // `accessibilityState={{ disabled: ... }}` is fine — that's an RN
    // semantic prop, not the HTML attribute.
    expect(
      pressableOpen,
      "Pressable must not pass native disabled prop",
    ).not.toMatch(/(?<!accessibilityState=\{\{\s*)\bdisabled=\{/);

    // Invariant 2: a ref is wired to the Pressable so the imperative
    // aria-disabled effect can target it.
    expect(pressableOpen).toMatch(/ref=\{cryptoButtonRef\}/);

    // Invariant 3: somewhere in the file body there is an effect that
    // calls setAttribute("aria-disabled", ...) on `cryptoButtonRef`.
    expect(body).toMatch(
      /cryptoButtonRef[\s\S]{0,400}setAttribute\(\s*"aria-disabled"/,
    );
  },
);
