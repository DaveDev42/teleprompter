import { describe, expect, test } from "bun:test";
import {
  isSessionState,
  type SessionState,
  toSessionState,
} from "./types/session";

describe("isSessionState", () => {
  test("accepts every known literal", () => {
    const states: SessionState[] = ["running", "stopped", "error"];
    for (const s of states) {
      expect(isSessionState(s)).toBe(true);
    }
  });

  test("rejects unknown strings", () => {
    expect(isSessionState("paused")).toBe(false);
    expect(isSessionState("")).toBe(false);
    expect(isSessionState("Running")).toBe(false); // case-sensitive
  });

  test("rejects non-strings", () => {
    expect(isSessionState(undefined)).toBe(false);
    expect(isSessionState(null)).toBe(false);
    expect(isSessionState(0)).toBe(false);
    expect(isSessionState({})).toBe(false);
  });
});

describe("toSessionState", () => {
  test("passes through known literals unchanged", () => {
    expect(toSessionState("running")).toBe("running");
    expect(toSessionState("stopped")).toBe("stopped");
    expect(toSessionState("error")).toBe("error");
  });

  test("degrades unknown values to 'error' rather than crossing the wire raw", () => {
    expect(toSessionState("paused")).toBe("error");
    expect(toSessionState("")).toBe("error");
    expect(toSessionState("garbage-from-a-legacy-row")).toBe("error");
  });
});
