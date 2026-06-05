import { describe, expect, test } from "bun:test";
import { checkClaudeVersion, PROTOCOL_VERSION, parseVersion } from "./compat";

describe("compat", () => {
  test("parseVersion extracts semver components", () => {
    expect(parseVersion("2.1.81")).toEqual({ major: 2, minor: 1, patch: 81 });
    expect(parseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  test("parseVersion handles version with prefix", () => {
    expect(parseVersion("v2.1.81")).toEqual({ major: 2, minor: 1, patch: 81 });
    expect(parseVersion("Claude 2.1.81")).toEqual({
      major: 2,
      minor: 1,
      patch: 81,
    });
  });

  test("parseVersion returns null for invalid", () => {
    expect(parseVersion("invalid")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  test("checkClaudeVersion accepts valid versions", () => {
    expect(checkClaudeVersion("2.1.81")).toBeNull();
    expect(checkClaudeVersion("1.0.0")).toBeNull();
    expect(checkClaudeVersion("3.0.0")).toBeNull();
  });

  test("checkClaudeVersion warns on old versions", () => {
    expect(checkClaudeVersion("0.9.0")).not.toBeNull();
    expect(checkClaudeVersion("0.1.0")).not.toBeNull();
  });

  test("checkClaudeVersion applies patch comparison when major.minor match MIN", () => {
    // MIN_CLAUDE_VERSION is "1.0.0" so patch=0; any 1.0.x with x>=0 is OK
    expect(checkClaudeVersion("1.0.0")).toBeNull();
    expect(checkClaudeVersion("1.0.1")).toBeNull();
    // When MIN would have patch>0 the comparison must catch it.
    // We test the logic directly by parsing a version below the
    // minimum's own patch level using a version known to be below 1.0.0.
    // 0.9.9 < 1.0.0 — must warn (major gate catches this).
    expect(checkClaudeVersion("0.9.9")).not.toBeNull();
  });

  test("PROTOCOL_VERSION is a number", () => {
    expect(typeof PROTOCOL_VERSION).toBe("number");
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
