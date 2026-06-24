import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { PushInterruptionLevel } from "@teleprompter/protocol";
import { setLogLevel } from "@teleprompter/protocol";
import {
  buildPushMessage,
  interruptionLevelFor,
  PushNotifier,
  type PushNotifierDeps,
} from "./push-notifier";

beforeAll(() => setLogLevel("silent"));
afterAll(() => setLogLevel("info"));

// Sealed blob used across tests (opaque to the daemon — not validated here)
const SEALED =
  "tpps1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const SEALED_B =
  "tpps1.1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==";

function makeSendPush() {
  return mock(
    (
      _frontendId: string,
      _sealed: string,
      _title: string,
      _body: string,
      _interruptionLevel: PushInterruptionLevel,
      _data: { sid: string; event: string },
    ) => {},
  );
}

function makePersistToken() {
  return mock(
    (
      _frontendId: string,
      _daemonId: string,
      _sealed: string,
      _platform: "ios" | "android",
    ) => {},
  );
}

function makeDeleteToken() {
  return mock((_frontendId: string) => {});
}

function makeLoadTokens(
  entries: Array<{
    frontendId: string;
    daemonId: string;
    sealed: string;
    platform: "ios" | "android";
  }> = [],
) {
  return mock(() => entries);
}

function makeDeps(overrides?: Partial<PushNotifierDeps>): PushNotifierDeps {
  return {
    sendPush: makeSendPush(),
    persistToken: makePersistToken(),
    loadTokens: makeLoadTokens(),
    deleteToken: makeDeleteToken(),
    ...overrides,
  };
}

describe("PushNotifier", () => {
  it("triggers push for Elicitation event", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    expect(
      (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls[0],
    ).toEqual([
      "fe-1",
      SEALED,
      "Response needed",
      "Claude is waiting for your answer",
      "time-sensitive",
      { sid: "s1", event: "Elicitation" },
    ]);
  });

  it("triggers push for PermissionRequest event", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "android");

    notifier.onRecord({ sid: "s2", kind: "event", name: "PermissionRequest" });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    expect(calls[0]).toEqual([
      "fe-1",
      SEALED,
      "Permission needed",
      "Tool permission approval required",
      "time-sensitive",
      { sid: "s2", event: "PermissionRequest" },
    ]);
  });

  it("uses tool_name in PermissionRequest body when provided", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "PermissionRequest",
      payload: { tool_name: "Bash" },
    });

    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[3]).toBe("Approve Bash to continue");
  });

  it("triggers push for Notification event", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Notification",
      payload: { message: "Claude needs your permission to use Bash" },
    });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[2]).toBe("Permission needed");
    expect(call0[3]).toBe("Claude needs your permission to use Bash");
  });

  it("falls back to generic Notification copy when message is missing", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Notification" });

    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[2]).toBe("Claude needs attention");
    expect(call0[3]).toBe("Tap to open the session");
  });

  it("does NOT trigger for Stop event", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Stop" });

    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger for io records", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "io" });

    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger for PostToolUse event", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "PostToolUse" });

    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it("does NOT trigger when no tokens are registered", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);

    notifier.onRecord({ sid: "s1", kind: "event", name: "Notification" });

    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it("sends to ALL registered frontends", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");
    notifier.registerSealedToken("fe-2", "d-1", SEALED_B, "android");
    notifier.registerSealedToken("fe-3", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(deps.sendPush).toHaveBeenCalledTimes(3);
    const frontendIds = (
      deps.sendPush as ReturnType<typeof makeSendPush>
    ).mock.calls.map((c) => c[0]);
    expect(frontendIds).toContain("fe-1");
    expect(frontendIds).toContain("fe-2");
    expect(frontendIds).toContain("fe-3");
  });

  it("updates sealed blob on re-register with same frontendId", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");
    notifier.registerSealedToken("fe-1", "d-1", SEALED_B, "android");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[1]).toBe(SEALED_B);
    expect(call0[0]).toBe("fe-1");
  });

  it("unregisterToken removes frontend from receiving pushes", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");
    notifier.registerSealedToken("fe-2", "d-1", SEALED_B, "android");
    notifier.unregisterToken("fe-1");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[0]).toBe("fe-2");
  });

  it.each([
    ["Notification"],
    ["PermissionRequest"],
    ["Elicitation"],
  ])("passes time-sensitive interruption level for attention-needed event %s", (eventName) => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: eventName });

    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    // interruptionLevel is the 5th positional arg (index 4)
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[4]).toBe("time-sensitive");
  });

  it("registerSealedToken writes Map AND calls persistToken", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    expect(deps.persistToken).toHaveBeenCalledTimes(1);
    const calls = (deps.persistToken as ReturnType<typeof makePersistToken>)
      .mock.calls;
    expect(calls[0]).toEqual(["fe-1", "d-1", SEALED, "ios"]);

    // Map entry present: triggers push on next event
    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });
    expect(deps.sendPush).toHaveBeenCalledTimes(1);
  });

  it("constructor seeds from loadTokens — no persistToken called on startup", () => {
    const persistToken = makePersistToken();
    const loadTokens = makeLoadTokens([
      {
        frontendId: "fe-seeded",
        daemonId: "d-1",
        sealed: SEALED,
        platform: "ios",
      },
    ]);
    const deps = makeDeps({ persistToken, loadTokens });
    const notifier = new PushNotifier(deps);

    // Loaded from store — persistToken should NOT be called on seed
    expect(persistToken).not.toHaveBeenCalled();

    // But the token IS in the Map
    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });
    expect(deps.sendPush).toHaveBeenCalledTimes(1);
    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[0]).toBe("fe-seeded");
    expect(call0[1]).toBe(SEALED);
  });

  it("onRecord passes entry.sealed (not plaintext) to sendPush", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    const mySealed = "tpps1.1.MYSPECIALSEALEDBLOB==";
    notifier.registerSealedToken("fe-1", "d-1", mySealed, "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Notification" });

    const calls = (deps.sendPush as ReturnType<typeof makeSendPush>).mock.calls;
    const call0 = calls[0];
    if (call0 === undefined) throw new Error("expected call 0");
    expect(call0[1]).toBe(mySealed);
  });

  it("handleUnsealFailed removes from Map AND calls deleteToken", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.handleUnsealFailed("fe-1");

    expect(deps.deleteToken).toHaveBeenCalledWith("fe-1");

    // Token is gone from the Map
    notifier.onRecord({ sid: "s1", kind: "event", name: "Elicitation" });
    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it("handleUnsealFailed is safe for unknown frontendIds", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);

    // Should not throw
    expect(() => notifier.handleUnsealFailed("fe-unknown")).not.toThrow();
    expect(deps.deleteToken).not.toHaveBeenCalled();
  });

  it("unregisterToken also calls deleteToken", () => {
    const deps = makeDeps();
    const notifier = new PushNotifier(deps);
    notifier.registerSealedToken("fe-1", "d-1", SEALED, "ios");

    notifier.unregisterToken("fe-1");

    expect(deps.deleteToken).toHaveBeenCalledWith("fe-1");
  });
});

describe("buildPushMessage", () => {
  it("Notification with idle/wait phrasing maps to Waiting title", () => {
    const m = buildPushMessage("Notification", {
      message: "Claude is waiting for your input",
    });
    expect(m.title).toBe("Waiting for input");
    expect(m.body).toBe("Claude is waiting for your input");
  });

  it("Notification with permission phrasing maps to Permission title", () => {
    const m = buildPushMessage("Notification", {
      message: "Permission required to run Bash",
    });
    expect(m.title).toBe("Permission needed");
  });

  it("truncates long Notification messages with ellipsis", () => {
    const long = "a".repeat(300);
    const m = buildPushMessage("Notification", { message: long });
    expect(m.body.endsWith("…")).toBe(true);
    expect(m.body.length).toBeLessThanOrEqual(178);
  });

  it("truncates on code-point boundaries — no lone surrogate (RFC-8259)", () => {
    // REGRESSION: truncate previously used s.length / s.slice (UTF-16 code
    // units), so an emoji straddling the 178-cap could be split, leaving a lone
    // surrogate → invalid JSON push body. Build a string whose 178th boundary
    // lands inside a surrogate pair (each 😀 is 2 UTF-16 units but 1 code point).
    const long = "😀".repeat(200);
    const m = buildPushMessage("Notification", { message: long });
    expect(m.body.endsWith("…")).toBe(true);
    // No unpaired surrogate anywhere in the body.
    for (let i = 0; i < m.body.length; i++) {
      const code = m.body.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate must be followed by a low surrogate
        const next = m.body.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++; // skip the paired low surrogate
      } else {
        // must not be a lone low surrogate
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it("Elicitation prefers `message` field, falls back to `question`", () => {
    expect(buildPushMessage("Elicitation", { message: "What now?" }).body).toBe(
      "What now?",
    );
    expect(buildPushMessage("Elicitation", { question: "Pick one" }).body).toBe(
      "Pick one",
    );
  });

  it("unknown event name returns safe default", () => {
    const m = buildPushMessage("ZZZ");
    expect(m.title).toBe("Claude needs attention");
  });
});

describe("interruptionLevelFor", () => {
  it.each([
    ["Notification"],
    ["PermissionRequest"],
    ["Elicitation"],
  ])("maps attention-needed event %s to time-sensitive", (eventName) => {
    expect(interruptionLevelFor(eventName)).toBe("time-sensitive");
  });

  it.each([
    ["Stop"],
    ["PostToolUse"],
    ["SessionEnd"],
    ["ZZZ"],
  ])("maps informational/unknown event %s to active (default)", (eventName) => {
    expect(interruptionLevelFor(eventName)).toBe("active");
  });
});
