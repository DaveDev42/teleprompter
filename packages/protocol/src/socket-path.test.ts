import { describe, expect, test } from "bun:test";
import { getSocketPath, getWindowsSocketPath } from "./socket-path";

describe.skipIf(process.platform === "win32")("getSocketPath", () => {
  test("returns a path ending with daemon.sock", () => {
    const path = getSocketPath();
    expect(path).toMatch(/daemon\.sock$/);
  });

  test("returns a consistent path on repeated calls", () => {
    const path1 = getSocketPath();
    const path2 = getSocketPath();
    expect(path1).toBe(path2);
  });

  test("path contains expected directory structure", () => {
    const path = getSocketPath();
    // Either XDG_RUNTIME_DIR or /tmp/teleprompter-{uid}
    expect(path).toMatch(/teleprompter|daemon\.sock/);
  });
});

describe("getWindowsSocketPath", () => {
  test("returns named pipe format", () => {
    const path = getWindowsSocketPath("TestUser");
    expect(path).toBe("\\\\.\\pipe\\teleprompter-TestUser-daemon");
  });

  test("does not contain forward slashes", () => {
    const path = getWindowsSocketPath("Dave");
    expect(path).not.toContain("/");
    expect(path).toMatch(/^\\\\\.\\pipe\\/);
  });
});
