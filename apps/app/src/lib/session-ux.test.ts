import { describe, expect, test } from "bun:test";
import type {
  SessionState,
  WsSessionMeta,
} from "@teleprompter/protocol/client";
import {
  deriveInputGates,
  isSessionRunning,
  isSessionStopped,
} from "./session-ux";

// Accept the SessionState union plus arbitrary test-only values (e.g. "crashed",
// "idle") to document that the helpers handle unknown states gracefully.
function makeSession(state: SessionState | (string & {})): WsSessionMeta {
  return {
    sid: "s1",
    state,
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
    lastSeq: 0,
  };
}

describe("isSessionStopped", () => {
  test("undefined session is not considered stopped", () => {
    expect(isSessionStopped(undefined)).toBe(false);
  });

  test("running session is not stopped", () => {
    expect(isSessionStopped(makeSession("running"))).toBe(false);
  });

  test("stopped session is stopped", () => {
    expect(isSessionStopped(makeSession("stopped"))).toBe(true);
  });

  test("any non-running state is treated as stopped", () => {
    expect(isSessionStopped(makeSession("crashed"))).toBe(true);
    expect(isSessionStopped(makeSession("idle"))).toBe(true);
  });
});

describe("isSessionRunning", () => {
  test("undefined session is not running", () => {
    expect(isSessionRunning(undefined)).toBe(false);
  });

  test("running session is running", () => {
    expect(isSessionRunning(makeSession("running"))).toBe(true);
  });

  test("stopped session is not running", () => {
    expect(isSessionRunning(makeSession("stopped"))).toBe(false);
  });

  test("any non-running state is treated as not running", () => {
    expect(isSessionRunning(makeSession("crashed"))).toBe(false);
    expect(isSessionRunning(makeSession("idle"))).toBe(false);
  });
});

describe("deriveInputGates", () => {
  const running = makeSession("running");
  const stopped = makeSession("stopped");

  test("running + connected + sid → editable and can send", () => {
    expect(deriveInputGates(running, true, "s1")).toEqual({
      isEditable: true,
      canSend: true,
    });
  });

  test("running + disconnected + sid → editable, cannot send", () => {
    expect(deriveInputGates(running, false, "s1")).toEqual({
      isEditable: true,
      canSend: false,
    });
  });

  test("running + connected + null sid → editable, cannot send", () => {
    expect(deriveInputGates(running, true, null)).toEqual({
      isEditable: true,
      canSend: false,
    });
  });

  test("stopped + connected + sid → not editable, cannot send", () => {
    expect(deriveInputGates(stopped, true, "s1")).toEqual({
      isEditable: false,
      canSend: false,
    });
  });

  test("stopped + disconnected + sid → not editable, cannot send", () => {
    expect(deriveInputGates(stopped, false, "s1")).toEqual({
      isEditable: false,
      canSend: false,
    });
  });

  test("undefined session (unknown) treated as not stopped", () => {
    expect(deriveInputGates(undefined, true, "s1")).toEqual({
      isEditable: true,
      canSend: true,
    });
  });
});
