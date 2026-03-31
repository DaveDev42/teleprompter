import { describe, expect, test } from "bun:test";
import { captureHookCommand } from "./capture-hook";

describe("captureHookCommand", () => {
  test("generates bun one-liner with socket path", () => {
    const cmd = captureHookCommand("/tmp/hook.sock");
    expect(cmd).toContain("bun -e");
    expect(cmd).toContain("/tmp/hook.sock");
    expect(cmd).toContain("Bun.stdin.text()");
    expect(cmd).toContain("Bun.connect");
  });

  test("handles paths with special characters", () => {
    const cmd = captureHookCommand("/tmp/teleprompter-501/hook-session-1.sock");
    expect(cmd).toContain("teleprompter-501");
    expect(cmd).toContain("hook-session-1.sock");
  });
});
