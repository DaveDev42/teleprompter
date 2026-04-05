import { describe, expect, test } from "bun:test";
import { splitArgs } from "./args";

describe("splitArgs", () => {
  test("no args returns empty", () => {
    const result = splitArgs([]);
    expect(result.tpArgs).toEqual({});
    expect(result.claudeArgs).toEqual([]);
  });

  test("claude-only args pass through unchanged", () => {
    const result = splitArgs(["-p", "hello world", "--model", "opus"]);
    expect(result.tpArgs).toEqual({});
    expect(result.claudeArgs).toEqual(["-p", "hello world", "--model", "opus"]);
  });

  test("--tp-sid is extracted", () => {
    const result = splitArgs(["--tp-sid", "my-session", "-p", "hello"]);
    expect(result.tpArgs.sid).toBe("my-session");
    expect(result.claudeArgs).toEqual(["-p", "hello"]);
  });

  test("--tp-cwd is extracted", () => {
    const result = splitArgs(["--tp-cwd", "/path/to/project", "-p", "hello"]);
    expect(result.tpArgs.cwd).toBe("/path/to/project");
    expect(result.claudeArgs).toEqual(["-p", "hello"]);
  });

  test("--tp-ws-port is extracted", () => {
    const result = splitArgs(["--tp-ws-port", "9090", "-p", "hello"]);
    expect(result.tpArgs.wsPort).toBe("9090");
    expect(result.claudeArgs).toEqual(["-p", "hello"]);
  });

  test("multiple --tp-* flags mixed with claude args", () => {
    const result = splitArgs([
      "--tp-sid",
      "s1",
      "-p",
      "hello",
      "--tp-cwd",
      "/tmp",
      "--model",
      "opus",
      "--tp-ws-port",
      "8080",
    ]);
    expect(result.tpArgs).toEqual({
      sid: "s1",
      cwd: "/tmp",
      wsPort: "8080",
    });
    expect(result.claudeArgs).toEqual(["-p", "hello", "--model", "opus"]);
  });

  test("--tp-* at the end of args", () => {
    const result = splitArgs(["-p", "hello", "--tp-sid", "last"]);
    expect(result.tpArgs.sid).toBe("last");
    expect(result.claudeArgs).toEqual(["-p", "hello"]);
  });

  test("exits with error on missing value for --tp-* flag", () => {
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode: number | undefined;
    let errorOutput = "";
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("__EXIT__");
    }) as never;
    console.error = (msg: string) => {
      errorOutput += `${msg}\n`;
    };

    try {
      expect(() => splitArgs(["--tp-sid"])).toThrow("__EXIT__");
      expect(exitCode).toBe(1);
      expect(errorOutput).toContain("--tp-sid requires a value");
      expect(errorOutput).toContain("Example:");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  test("unknown --tp-like flags are passed to claude", () => {
    // --tp-unknown is NOT a recognized tp flag, so it goes to claude
    const result = splitArgs(["--tp-unknown", "value", "-p", "hello"]);
    expect(result.tpArgs).toEqual({});
    expect(result.claudeArgs).toEqual(["--tp-unknown", "value", "-p", "hello"]);
  });

  test("preserves argument order for claude", () => {
    const result = splitArgs([
      "--allowedTools",
      "Bash",
      "Edit",
      "--tp-sid",
      "x",
      "-p",
      "do something",
    ]);
    expect(result.claudeArgs).toEqual([
      "--allowedTools",
      "Bash",
      "Edit",
      "-p",
      "do something",
    ]);
  });
});
