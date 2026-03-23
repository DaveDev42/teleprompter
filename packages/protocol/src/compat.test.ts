import { describe, test, expect } from "bun:test";
import { parseVersion, checkClaudeVersion, PROTOCOL_VERSION } from "./compat";

describe("compat", () => {
  test("parseVersion extracts semver components", () => {
    expect(parseVersion("2.1.81")).toEqual({ major: 2, minor: 1, patch: 81 });
    expect(parseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  test("parseVersion handles version with prefix", () => {
    expect(parseVersion("v2.1.81")).toEqual({ major: 2, minor: 1, patch: 81 });
    expect(parseVersion("Claude 2.1.81")).toEqual({ major: 2, minor: 1, patch: 81 });
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

  test("PROTOCOL_VERSION is a number", () => {
    expect(typeof PROTOCOL_VERSION).toBe("number");
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
