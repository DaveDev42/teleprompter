import { describe, expect, test } from "bun:test";
import { parseHookEvent } from "./hook-guard";

/** Assert the guard accepts `input` and returns it structurally unchanged. */
function expectAccepted(input: unknown): void {
  expect(parseHookEvent(input)).toEqual(
    input as ReturnType<typeof parseHookEvent>,
  );
}

/** Assert the guard rejects `input` (returns null). */
function expectRejected(input: unknown): void {
  expect(parseHookEvent(input)).toBeNull();
}

/**
 * Zero-trust boundary tests for the hook socket (Claude Code → Runner). The
 * HookReceiver used to cast `JSON.parse(text)` straight to `HookEventBase` and
 * read `event.hook_event_name` — a truncated payload or an object missing the
 * discriminant would forward `undefined` into the record pipeline. These tests
 * pin the envelope-validation contract: discriminant + session_id + cwd, with
 * the arbitrary per-event payload preserved.
 */
describe("parseHookEvent", () => {
  describe("non-objects and missing envelope", () => {
    test.each<[unknown]>([
      [null],
      [undefined],
      [42],
      ["string"],
      [true],
      [[]],
      [[{ hook_event_name: "Stop", session_id: "s", cwd: "/" }]],
    ])("rejects non-plain-object %p", (v) => {
      expectRejected(v);
    });

    test("rejects an object with no hook_event_name", () => {
      expectRejected({ session_id: "s", cwd: "/work" });
    });
    test("rejects an unknown hook_event_name", () => {
      expectRejected({
        hook_event_name: "TotallyNotAHook",
        session_id: "s",
        cwd: "/work",
      });
    });
    test("rejects a non-string hook_event_name", () => {
      expectRejected({ hook_event_name: 7, session_id: "s", cwd: "/work" });
    });
    test("rejects a missing session_id", () => {
      expectRejected({ hook_event_name: "Stop", cwd: "/work" });
    });
    test("rejects a non-string session_id", () => {
      expectRejected({ hook_event_name: "Stop", session_id: 1, cwd: "/work" });
    });
    test("rejects a missing cwd", () => {
      expectRejected({ hook_event_name: "Stop", session_id: "s" });
    });
    test("rejects a non-string cwd", () => {
      expectRejected({ hook_event_name: "Stop", session_id: "s", cwd: 5 });
    });
  });

  describe("accepts every known hook event name", () => {
    test.each<[string]>([
      ["SessionStart"],
      ["SessionEnd"],
      ["UserPromptSubmit"],
      ["Stop"],
      ["StopFailure"],
      ["PreToolUse"],
      ["PostToolUse"],
      ["PostToolUseFailure"],
      ["PermissionRequest"],
      ["Notification"],
      ["SubagentStart"],
      ["SubagentStop"],
      ["PreCompact"],
      ["PostCompact"],
      ["Elicitation"],
      ["ElicitationResult"],
    ])("accepts %s", (name) => {
      expectAccepted({
        hook_event_name: name,
        session_id: "s1",
        cwd: "/work",
      });
    });
  });

  describe("preserves the per-event payload", () => {
    test("rides arbitrary extra fields through unchanged", () => {
      // HookEventBase has an index signature; the variant body (tool_name,
      // tool_input, last_assistant_message, …) must survive validation so the
      // downstream typed narrowings (StopEvent, PreToolUseEvent) still work.
      const event = {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/work",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        nested: { a: [1, 2, 3] },
      };
      const parsed = parseHookEvent(event);
      expect(parsed).toEqual(event as unknown as NonNullable<typeof parsed>);
      expect(parsed?.tool_name).toBe("Bash");
    });

    test("returns the same object reference (no reconstruction)", () => {
      const event = {
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: "/work",
        last_assistant_message: "done",
      };
      const parsed = parseHookEvent(event);
      expect(parsed).toBe(event as unknown as NonNullable<typeof parsed>);
    });
  });
});
