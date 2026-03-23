import { describe, test, expect } from "bun:test";
import { splitArgs } from "../args";

describe("passthrough arg splitting", () => {
  test("passes all non-tp args to claude", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "-p",
      "explain this code",
      "--model",
      "opus",
    ]);
    expect(tpArgs).toEqual({});
    expect(claudeArgs).toEqual(["-p", "explain this code", "--model", "opus"]);
  });

  test("extracts tp-sid and forwards rest", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "--tp-sid",
      "my-session",
      "-p",
      "hello",
    ]);
    expect(tpArgs.sid).toBe("my-session");
    expect(claudeArgs).toEqual(["-p", "hello"]);
  });

  test("extracts all tp flags from mixed args", () => {
    const { tpArgs, claudeArgs } = splitArgs([
      "--tp-sid",
      "s1",
      "--tp-cwd",
      "/tmp",
      "--tp-ws-port",
      "9090",
      "-p",
      "fix bug",
      "--model",
      "sonnet",
    ]);
    expect(tpArgs).toEqual({ sid: "s1", cwd: "/tmp", wsPort: "9090" });
    expect(claudeArgs).toEqual(["-p", "fix bug", "--model", "sonnet"]);
  });

  test("defaults are applied correctly", () => {
    const { tpArgs } = splitArgs(["-p", "hello"]);
    expect(tpArgs.sid).toBeUndefined();
    expect(tpArgs.cwd).toBeUndefined();
    expect(tpArgs.wsPort).toBeUndefined();
  });
});
