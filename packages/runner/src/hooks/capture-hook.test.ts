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

  test("outer shell argument is single-quoted", () => {
    const cmd = captureHookCommand("/tmp/hook.sock");
    // The bun -e argument must be wrapped in single quotes (not double quotes),
    // so that the inner JSON double-quotes don't prematurely terminate the shell arg.
    expect(cmd).toMatch(/^bun -e '/);
    expect(cmd.endsWith("'")).toBe(true);
  });

  test("uses JSON.stringify for the socket path (double-quoted JS literal)", () => {
    // The path must appear as a JSON-quoted string (e.g. "/tmp/hook.sock"),
    // NOT as a raw single-quoted string ('…'). This ensures paths with single
    // quotes, backslashes, or spaces don't break the generated one-liner.
    const cmd = captureHookCommand("/tmp/hook.sock");
    expect(cmd).toContain('unix:"/tmp/hook.sock"');
    expect(cmd).not.toContain("unix:'/tmp/hook.sock'");
  });

  test("full Bun.connect call and closing }); survive in the command (not truncated)", () => {
    // The old bug truncated the script at the first inner double-quote,
    // so Bun.connect and the closing }); would be missing.
    const cmd = captureHookCommand("/tmp/hook.sock");
    expect(cmd).toContain("Bun.connect(");
    expect(cmd).toContain("});");
  });

  test("handles paths with special characters", () => {
    const cmd = captureHookCommand("/tmp/teleprompter-501/hook-session-1.sock");
    expect(cmd).toContain("teleprompter-501");
    expect(cmd).toContain("hook-session-1.sock");
  });

  test("escapes single-quote in path via POSIX '\\'' idiom", () => {
    // A path containing a single-quote must be escaped so the outer single-quoted
    // shell argument is not broken. JSON.stringify does NOT escape single-quotes
    // (they are not JSON special chars), so the script body will contain a raw
    // single-quote that we must escape via the '\'' sequence.
    const path = "/tmp/it's-a-hook.sock";
    const cmd = captureHookCommand(path);
    // The command must contain the POSIX escape sequence for the single-quote.
    expect(cmd).toContain("'\\''");
    // The full Bun.connect call must still be present (not truncated).
    expect(cmd).toContain("Bun.connect(");
    expect(cmd).toContain("});");
    // The path value must appear inside the script as a JSON string.
    // JSON.stringify("/tmp/it's-a-hook.sock") => '"/tmp/it\'s-a-hook.sock"' — wait,
    // JSON.stringify does NOT escape single-quotes, it produces: "/tmp/it's-a-hook.sock"
    // That single-quote inside the script then gets POSIX-escaped to '\'' in the command.
    expect(cmd).toContain('unix:"/tmp/it');
    // Verify the script body is syntactically intact: strip outer single-quotes
    // (with '\'' un-escaped back to ') and check it's valid JS.
    const inner = cmd
      .replace(/^bun -e '/, "")
      .replace(/'$/, "")
      .replace(/'\\''/g, "'");
    // Must contain the complete Bun.connect call.
    expect(inner).toContain("Bun.connect(");
    expect(inner).toContain("unix:");
    expect(inner).toContain("});");
    // Must be parseable as JS (no syntax error from truncation).
    // The script uses top-level await, so wrap in async to validate with new Function.
    expect(() => new Function(`return (async () => { ${inner} })()`)).not.toThrow();
  });

  test("escapes path with spaces via JSON.stringify", () => {
    const path = "/tmp/my hooks/hook.sock";
    const cmd = captureHookCommand(path);
    expect(cmd).toContain(JSON.stringify(path));
    // The path (with space) must appear in the command correctly quoted.
    expect(cmd).toContain('"' + path + '"');
  });

  test("script body (with outer quotes stripped) is valid parseable JS", () => {
    const cmd = captureHookCommand("/tmp/hook.sock");
    // Strip leading `bun -e '` and trailing `'`.
    const inner = cmd.replace(/^bun -e '/, "").replace(/'$/, "");
    // The script uses top-level await, so wrap in async to validate with new Function.
    expect(() => new Function(`return (async () => { ${inner} })()`)).not.toThrow();
    expect(inner).toContain("Bun.connect(");
    expect(inner).toContain("});");
  });
});
