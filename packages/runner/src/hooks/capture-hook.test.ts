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

  test("uses JSON.stringify for the socket path (double-quoted JS literal)", () => {
    // The path must appear as a JSON-quoted string (e.g. "/tmp/hook.sock"),
    // NOT as a raw single-quoted string ('…'). This ensures paths with single
    // quotes, backslashes, or spaces don't break the generated one-liner.
    const cmd = captureHookCommand("/tmp/hook.sock");
    expect(cmd).toContain('unix:"/tmp/hook.sock"');
    expect(cmd).not.toContain("unix:'/tmp/hook.sock'");
  });

  test("handles paths with special characters", () => {
    const cmd = captureHookCommand("/tmp/teleprompter-501/hook-session-1.sock");
    expect(cmd).toContain("teleprompter-501");
    expect(cmd).toContain("hook-session-1.sock");
  });

  test("escapes single-quote in path via JSON.stringify", () => {
    // A path containing a single-quote would previously break the shell command.
    const path = "/tmp/it's-a-hook.sock";
    const cmd = captureHookCommand(path);
    // JSON.stringify escapes nothing in this case since there are no JSON special
    // chars; the key invariant is no bare single-quote in the unix: value position.
    expect(cmd).toContain(JSON.stringify(path));
    // The command must be parseable as valid JS when extracted from the shell arg.
    const jsBody = cmd.replace(/^bun -e "/, "").replace(/"$/, "");
    // Verify no broken single-quote literal in the unix: position.
    expect(jsBody).not.toMatch(/unix:'[^']*'/);
  });

  test("escapes path with spaces via JSON.stringify", () => {
    const path = "/tmp/my hooks/hook.sock";
    const cmd = captureHookCommand(path);
    expect(cmd).toContain(JSON.stringify(path));
    // The path (with space) must appear in the command correctly quoted.
    expect(cmd).toContain('"' + path + '"');
  });
});
